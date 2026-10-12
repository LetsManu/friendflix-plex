/**
 * Keeps the Postgres mirror in step with Plex and turns changes into neutral media events.
 *
 * - run(): one pass. Lists every movie/show section completely (paged; metadata edits such as a new contentRating do NOT bump
 *   Plex's updatedAt, so an updatedAt-based incremental sync would miss them), upserts the core columns, removes vanished items,
 *   then fetches details (tags with ids, guids, streams, markers, extras) of new / changed / stale items in batches.
 * - poll every 5 min, nightly sweep (all details again), and the PMS notification websocket (timeline events mark an item stale
 *   and trigger a debounced pass).
 * - itemAdded / itemRemoved events for the media event pipeline (never on the very first pass of an empty mirror).
 */
import type { Db } from '../db.js';
import type { MediaEvent, MediaRuntime } from '../media/types.js';
import { refreshAges } from './access.js';
import type { PlexClient } from './client.js';
import { encodePlexId } from './ids.js';
import { coreRow, detailRow, tagRows, upsertCore, writeCollectionItems, writeDetails, type CoreRow, type DetailRow, type TagRow } from './mirror.js';

const LIST_TYPES: Record<string, number[]> = { movie: [1], show: [2, 3, 4] };
const DETAIL_BATCH = 20;
const PAGE = 500;
export const POLL_MS = 5 * 60_000;
const DEBOUNCE_MS = 3_000;
/** local hour of the nightly full detail sweep */
const SWEEP_HOUR = 3;
/** consecutive successful passes a section must be missing (or list no items) before the mirror drops it */
export const MISSING_PASSES = 3;

type Log = MediaRuntime['log'];
const noLog: Log = { warn: () => undefined, info: () => undefined };

export interface SyncResult { added: string[]; removed: string[]; details: number; sections: number }

export class PlexSync {
  private running: Promise<SyncResult> | null = null;
  private again: { all: boolean } | null = null;
  private timers: NodeJS.Timeout[] = [];
  private debounce: NodeJS.Timeout | null = null;
  private ws: WebSocket | null = null;
  private wsRetry = 0;
  private stopped = true;
  private lastSweep = '';
  private rt: MediaRuntime | null = null;

  constructor(
    private readonly client: PlexClient,
    private readonly db: Db,
    private readonly ready: () => Promise<void>,
    /** after every pass (the service drops its item memo: visibility may have changed) */
    private readonly after: () => Promise<void> | void = () => undefined,
  ) {}

  private get log(): Log {
    return this.rt?.log ?? noLog;
  }

  /**
   * One sync pass (concurrent callers share the running one; a request during a pass schedules exactly one more).
   * allDetails: refetch the details of every item (nightly sweep).
   */
  run(opts: { allDetails?: boolean } = {}): Promise<SyncResult> {
    if (this.running) {
      this.again = { all: Boolean(this.again?.all || opts.allDetails) };
      return this.running;
    }
    const p = this.pass(Boolean(opts.allDetails)).finally(() => {
      this.running = null;
      const next = this.again;
      this.again = null;
      if (next && !this.stopped) void this.run({ allDetails: next.all }).catch((e) => this.log.warn({ err: String(e) }, 'plex sync failed'));
    });
    this.running = p;
    return p;
  }

  private async pass(allDetails: boolean): Promise<SyncResult> {
    await this.ready();
    const db = this.db;
    const initial = !(await db.query('select 1 from plex_sync_state where k = $1', ['initialized'])).rowCount;
    const sections = (await this.client.sections()).filter((s) => LIST_TYPES[String(s.type)] && /^\d+$/.test(String(s.key)));
    const sectionIds = sections.map((s) => Number(s.key));
    const added: string[] = [];
    const removed: string[] = [];
    let details: number;
    try {
      await db.query(
        `insert into plex_sections(section_id, type, title, uuid, seen_at, missing_passes) select x.id, x.type, x.title, x.uuid, now(), 0
         from jsonb_to_recordset($1::jsonb) as x(id int, type text, title text, uuid text)
         on conflict (section_id) do update set type = excluded.type, title = excluded.title, uuid = excluded.uuid, seen_at = now(), missing_passes = 0`,
        [JSON.stringify(sections.map((s) => ({ id: Number(s.key), type: String(s.type), title: String(s.title ?? ''), uuid: s.uuid ?? null })))],
      );

      const needDetail = new Set<string>();
      for (const s of sections) {
        const sid = Number(s.key);
        const before = new Map(
          (await db.query<{ rating_key: string; plex_updated_at: string | null; detail_at: Date | null; type: string }>(
            `select rating_key, plex_updated_at, detail_at, type from plex_items where section_id = $1 and type <> 'clip'`, [sid])).rows
            .map((r) => [String(r.rating_key), r]),
        );
        const seen = new Set<string>();
        let listed = 0;
        for (const t of LIST_TYPES[String(s.type)]!) {
          for await (const page of this.client.paged(`/library/sections/${sid}/all?type=${t}&includeGuids=1`, PAGE)) {
            const rows = page.map((m) => coreRow(m, sid)).filter((r): r is CoreRow => r !== null);
            await upsertCore(db, rows);
            listed += rows.length;
            for (const r of rows) {
              seen.add(r.rating_key);
              const old = before.get(r.rating_key);
              if (!old) added.push(r.rating_key);
              if (r.type === 'season') continue; // seasons carry nothing a detail fetch would add
              if (allDetails || !old || !old.detail_at || String(old.plex_updated_at ?? '') !== String(r.plex_updated_at ?? '')) needDetail.add(r.rating_key);
            }
          }
        }
        // collections (+ members: the item side only names them by tag)
        for await (const page of this.client.paged(`/library/sections/${sid}/collections`, PAGE)) {
          const rows = page.map((m) => coreRow({ ...m, type: 'collection' }, sid)).filter((r): r is CoreRow => r !== null);
          await upsertCore(db, rows);
          for (const r of rows) {
            seen.add(r.rating_key);
            if (!before.has(r.rating_key)) added.push(r.rating_key);
            const old = before.get(r.rating_key);
            if (!allDetails && old && String(old.plex_updated_at ?? '') === String(r.plex_updated_at ?? '') && old.detail_at) continue;
            const members: string[] = [];
            for await (const kids of this.client.paged(`/library/collections/${r.rating_key}/children`, PAGE)) {
              for (const k of kids) if (/^\d+$/.test(String(k.ratingKey))) members.push(String(k.ratingKey));
            }
            await writeCollectionItems(db, r.rating_key, members);
            await db.query('update plex_items set detail_at = now() where rating_key = $1', [r.rating_key]);
          }
        }
        // a section that suddenly lists nothing while the mirror has items for it: only believed after MISSING_PASSES passes
        // (a PMS hiccup must not remove - and later re-add - a whole library, with an itemRemoved/itemAdded storm)
        let trustEmpty = true;
        if (listed === 0 && [...before.values()].some((r) => r.type !== 'collection')) {
          const n = (await db.query<{ empty_passes: number }>('update plex_sections set empty_passes = empty_passes + 1 where section_id = $1 returning empty_passes', [sid])).rows[0]?.empty_passes ?? 0;
          trustEmpty = n >= MISSING_PASSES;
          if (!trustEmpty) this.log.warn({ section: sid, items: before.size, passes: n }, 'plex: section listed no items, keeping the mirror for now');
        } else {
          await db.query('update plex_sections set empty_passes = 0 where section_id = $1 and empty_passes <> 0', [sid]);
        }
        const gone = trustEmpty ? [...before.keys()].filter((k) => !seen.has(k)) : [];
        if (gone.length) {
          const del = await db.query<{ rating_key: string }>('delete from plex_items where rating_key = any($1::bigint[]) returning rating_key', [gone]);
          removed.push(...del.rows.map((r) => String(r.rating_key)));
        }
      }

      // sections Plex no longer lists: dropped (with their items) only after MISSING_PASSES consecutive successful passes; an empty
      // section list while the mirror has items is never believed (PMS starting up, a database migration, a proxy error page …)
      const mirrorRows = (await db.query('select 1 from plex_items limit 1')).rowCount ?? 0;
      if (sections.length === 0 && mirrorRows > 0) {
        this.log.warn({}, 'plex: the server listed no movie/show sections, keeping the mirror');
      } else {
        await db.query('update plex_sections set missing_passes = missing_passes + 1 where not (section_id = any($1::int[]))', [sectionIds]);
        const drop = (await db.query<{ section_id: number }>('select section_id from plex_sections where missing_passes >= $1', [MISSING_PASSES])).rows.map((r) => r.section_id);
        if (drop.length) {
          const goneSections = await db.query<{ rating_key: string; type: string }>(
            'delete from plex_items where section_id = any($1::int[]) returning rating_key, type', [drop]);
          removed.push(...goneSections.rows.filter((r) => r.type !== 'clip').map((r) => String(r.rating_key)));
          await db.query('delete from plex_sections where section_id = any($1::int[])', [drop]);
        }
      }
      // extras whose owner is gone
      await db.query(`delete from plex_items c where c.type = 'clip' and not exists (select 1 from plex_items o where o.rating_key = c.parent_key)`);
      await db.query(`delete from plex_collection_items ci where not exists (select 1 from plex_items i where i.rating_key = ci.item_key)`);

      // items a websocket event marked stale (detail_at null) although their updatedAt did not change
      for (const r of (await db.query<{ rating_key: string }>(`select rating_key from plex_items where detail_at is null and type in ('movie', 'show', 'episode')`)).rows) {
        needDetail.add(String(r.rating_key));
      }
      details = await this.fetchDetails([...needDetail]);
    } finally {
      // always, also when the pass aborted half-way: upsertCore() nulled the ages of re-rated items (hidden for capped profiles),
      // this recomputes them from what was written so far
      await refreshAges(db, this.log).catch((e) => this.log.warn({ err: String(e) }, 'plex: age refresh failed'));
      await Promise.resolve(this.after()).catch(() => undefined);
    }
    if (initial) {
      await db.query(`insert into plex_sync_state(k, v) values ('initialized', to_jsonb(now())) on conflict (k) do nothing`);
    } else {
      await this.emit(added, removed);
    }
    await db.query(`insert into plex_sync_state(k, v) values ('last_sync', to_jsonb(now())) on conflict (k) do update set v = excluded.v`);
    return { added, removed, details, sections: sections.length };
  }

  /** Detail fetch (`/library/metadata/a,b,c`) in batches; extras become `clip` rows owned by their item. */
  private async fetchDetails(keys: string[]): Promise<number> {
    let n = 0;
    for (let i = 0; i < keys.length; i += DETAIL_BATCH) {
      const batch = keys.slice(i, i + DETAIL_BATCH);
      let list: Array<Record<string, any>>;
      try {
        list = (await this.client.container(`/library/metadata/${batch.join(',')}?includeGuids=1&includeMarkers=1&includeExtras=1`)).Metadata ?? [];
      } catch (e) {
        this.log.warn({ err: String(e) }, 'plex: detail fetch failed');
        continue;
      }
      const cores: CoreRow[] = [];
      const details: DetailRow[] = [];
      const tags: TagRow[] = [];
      const extrasOf = new Map<string, string[]>();
      for (const m of list) {
        const owner = await this.sectionOf(String(m.ratingKey));
        if (owner === null) continue;
        const core = coreRow(m, owner);
        const det = detailRow(m);
        if (!core || !det) continue;
        cores.push(core);
        details.push(det);
        tags.push(...tagRows(m));
        const ex: string[] = [];
        for (const x of Array.isArray(m.Extras?.Metadata) ? m.Extras.Metadata : []) {
          const c = coreRow({ ...x, type: 'clip' }, owner);
          const d = detailRow(x);
          if (!c || !d) continue;
          c.parent_key = core.rating_key;
          c.grandparent_key = null;
          c.section_id = owner;
          cores.push(c);
          details.push(d);
          ex.push(c.rating_key);
        }
        extrasOf.set(core.rating_key, ex);
      }
      await upsertCore(this.db, cores);
      await writeDetails(this.db, details, tags);
      for (const [owner, ex] of extrasOf) {
        await this.db.query(`delete from plex_items where type = 'clip' and parent_key = $1 and not (rating_key = any($2::bigint[]))`, [owner, ex]);
      }
      n += list.length;
    }
    return n;
  }

  private async sectionOf(rk: string): Promise<number | null> {
    const r = await this.db.query<{ section_id: number }>('select section_id from plex_items where rating_key = $1', [rk]);
    return r.rows[0]?.section_id ?? null;
  }

  private async emit(added: string[], removed: string[]): Promise<void> {
    if (!this.rt) return;
    const events: MediaEvent[] = [];
    if (added.length) {
      const r = await this.db.query<{ rating_key: string; type: string; guids: string[]; grandparent_key: string | null; idx: number | null; parent_idx: number | null }>(
        `select rating_key, type, guids, grandparent_key, idx, parent_idx from plex_items where rating_key = any($1::bigint[]) and type in ('movie', 'show', 'episode')`,
        [added]);
      for (const x of r.rows) {
        const id = encodePlexId('item', x.rating_key);
        if (x.type === 'episode') {
          events.push({ type: 'itemAdded', itemId: id, itemType: 'Episode', ...(x.grandparent_key ? { seriesId: encodePlexId('item', x.grandparent_key) } : {}), ...(x.parent_idx !== null ? { season: x.parent_idx } : {}), ...(x.idx !== null ? { episode: x.idx } : {}) });
        } else {
          const tmdb = (x.guids ?? []).map((g) => /^tmdb:\/\/(\d+)$/.exec(g)?.[1]).find(Boolean);
          events.push({ type: 'itemAdded', itemId: id, itemType: x.type === 'movie' ? 'Movie' : 'Series', ...(tmdb ? { tmdbId: Number(tmdb) } : {}) });
        }
      }
    }
    for (const k of removed) events.push({ type: 'itemRemoved', itemId: encodePlexId('item', k) });
    for (const e of events) await this.rt.dispatch(e).catch((err) => this.log.warn({ err: String(err), itemId: e.itemId }, 'plex: media event failed'));
  }

  // ---------------------------------------------------------------- lifecycle

  /** Starts polling, the nightly sweep and the websocket; the first pass runs in the background. */
  start(rt: MediaRuntime, opts: { websocket?: boolean } = {}): void {
    this.rt = rt;
    this.stopped = false;
    const kick = (all = false) => void this.run({ allDetails: all }).catch((e) => this.log.warn({ err: String(e) }, 'plex sync failed'));
    kick();
    this.timers.push(setInterval(() => {
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      if (now.getHours() === SWEEP_HOUR && this.lastSweep !== day) {
        this.lastSweep = day;
        kick(true);
      } else kick();
    }, POLL_MS));
    if (opts.websocket !== false) this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
    this.ws = null;
    await this.running?.catch(() => undefined);
  }

  /** Handles one websocket frame (exported for tests): library timeline entries mark items stale and schedule a pass. */
  async onNotification(raw: string): Promise<void> {
    let j: any;
    try {
      j = JSON.parse(raw);
    } catch {
      return;
    }
    const nc = j?.NotificationContainer;
    if (nc?.type !== 'timeline' || !Array.isArray(nc.TimelineEntry)) return;
    const keys: string[] = [];
    let relevant = false;
    for (const t of nc.TimelineEntry) {
      if (t?.identifier !== 'com.plexapp.plugins.library') continue;
      const state = Number(t.state);
      if (state !== 5 && state !== 9) continue; // 5 = done (created / updated), 9 = deleted
      relevant = true;
      if (/^\d{1,18}$/.test(String(t.itemID))) keys.push(String(t.itemID));
    }
    if (!relevant) return;
    if (keys.length) await this.db.query('update plex_items set detail_at = null where rating_key = any($1::bigint[])', [keys]).catch(() => undefined);
    this.schedule();
  }

  private schedule() {
    if (this.stopped) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.run().catch((e) => this.log.warn({ err: String(e) }, 'plex sync failed'));
    }, DEBOUNCE_MS);
  }

  private connect() {
    if (this.stopped || typeof WebSocket === 'undefined') return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.client.websocketUrl());
    } catch {
      return this.reconnect();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.wsRetry = 0;
    };
    ws.onmessage = (ev) => void this.onNotification(String(ev.data)).catch(() => undefined);
    ws.onclose = () => {
      if (this.ws === ws) this.reconnect();
    };
    ws.onerror = () => undefined; // onclose follows; never log the URL (it carries the token)
  }

  private reconnect() {
    if (this.stopped) return;
    this.ws = null;
    const delay = Math.min(300_000, 5_000 * 2 ** Math.min(this.wsRetry++, 6));
    const t = setTimeout(() => {
      this.timers = this.timers.filter((x) => x !== t);
      this.connect();
    }, delay);
    this.timers.push(t);
  }
}
