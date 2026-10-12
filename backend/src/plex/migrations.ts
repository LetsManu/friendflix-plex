import type pg from 'pg';

/**
 * Fork-only schema (FriendFlix for Plex). Kept OUT of the upstream MIGRATIONS array in ../db.ts so upstream migration numbers
 * never collide: own version table `plex_schema_migrations`, own advisory lock. Append only.
 *
 * Tables:
 * - plex_sections / plex_items / plex_tags / plex_collection_items: mirror of the Plex library (sync.ts), the source of every
 *   browse query (access rules are applied in SQL, see access.ts).
 * - plex_ratings: content rating string -> age (null = unrated, -1 = unknown => fail closed), refreshed from access.ts.
 * - plex_identities + plex_media_policies: the synthetic per-account/per-profile identities (users.jellyfin_user_id /
 *   profiles.jellyfin_user_id hold their ids) and their role/kids policy.
 * - plex_userdata: played / resume / favourites per identity (never written to Plex).
 * - plex_sync_state: small key/value state of the sync job.
 * plex_items.chapters (3): chapter marks of a video (start ms, name, chapter image media id + index when PMS made thumbnails).
 */
export const PLEX_MIGRATIONS: string[] = [
  // 1: mirror, identities, policies, user data
  `
  create table plex_sections (
    section_id int primary key,
    type text not null,
    title text not null,
    uuid text,
    seen_at timestamptz not null default now()
  );
  create table plex_items (
    rating_key bigint primary key,
    section_id int not null,
    type text not null check (type in ('movie', 'show', 'season', 'episode', 'collection', 'clip')),
    parent_key bigint,
    grandparent_key bigint,
    title text not null default '',
    title_sort text,
    original_title text,
    summary text,
    year int,
    originally_available date,
    content_rating text,
    inherit_rating text,
    age_req smallint,
    age_opt smallint,
    audience_rating real,
    critic_rating real,
    studio text,
    duration_ms bigint,
    idx int,
    parent_idx int,
    leaf_count int,
    child_count int,
    added_at timestamptz,
    plex_updated_at bigint,
    thumb text,
    art text,
    logo text,
    parent_thumb text,
    grandparent_thumb text,
    guids text[] not null default '{}',
    extra_type text,
    media jsonb,
    markers jsonb,
    detail_at timestamptz,
    seen_gen bigint not null default 0
  );
  create index plex_items_section on plex_items(section_id, type);
  create index plex_items_parent on plex_items(parent_key);
  create index plex_items_grandparent on plex_items(grandparent_key);
  create index plex_items_type_added on plex_items(type, added_at desc);
  create index plex_items_guids on plex_items using gin(guids);
  create table plex_tags (
    rating_key bigint not null references plex_items(rating_key) on delete cascade,
    kind text not null,
    tag text not null,
    tag_id bigint,
    role text,
    thumb text,
    pos int not null default 0,
    primary key (rating_key, kind, tag)
  );
  create index plex_tags_kind_tag on plex_tags(kind, lower(tag));
  create index plex_tags_tag_id on plex_tags(tag_id) where tag_id is not null;
  create table plex_collection_items (
    collection_key bigint not null references plex_items(rating_key) on delete cascade,
    item_key bigint not null,
    pos int not null default 0,
    primary key (collection_key, item_key)
  );
  create index plex_collection_items_item on plex_collection_items(item_key);
  create table plex_ratings (
    rating text primary key,
    age smallint
  );
  create table plex_identities (
    id text primary key,
    name text not null,
    created_at timestamptz not null default now()
  );
  create table media_policies (
    identity_id text primary key references plex_identities(id) on delete cascade,
    libraries text[],
    max_age smallint,
    block_unrated text[] not null default '{}',
    disabled boolean not null default false,
    hidden boolean not null default false,
    max_bitrate int,
    max_streams int,
    transcoding boolean not null default true,
    max_height int,
    download boolean not null default false,
    updated_at timestamptz not null default now()
  );
  create table plex_userdata (
    identity_id text not null,
    rating_key bigint not null,
    played boolean not null default false,
    play_count int not null default 0,
    position_ticks bigint not null default 0,
    favorite boolean not null default false,
    last_played timestamptz,
    updated_at timestamptz not null default now(),
    primary key (identity_id, rating_key)
  );
  create index plex_userdata_last on plex_userdata(identity_id, last_played desc);
  create table plex_sync_state (
    k text primary key,
    v jsonb not null
  );
  `,
  // 2: fork table names carry the plex_ prefix (no clash with a future upstream table); section disappearance / empty listing
  // counters (sync.ts: a section or its items are only dropped after MISSING_PASSES consecutive successful passes)
  `
  alter table media_policies rename to plex_media_policies;
  alter table plex_sections add column missing_passes int not null default 0;
  alter table plex_sections add column empty_passes int not null default 0;
  `,
  // 3: Block 17 parity - chapter marks (includeChapters=1) and the stream keys behind the quality traits (HDR / Dolby Vision /
  // audio layout) are new in the detail fetch: mark every detail stale so the next sync pass refetches them
  `
  alter table plex_items add column chapters jsonb;
  update plex_items set detail_at = null where type in ('movie', 'show', 'episode');
  `,
];

/** Same lock id scheme as ../db.ts migrate(), different number: the two never wait on each other. */
const PLEX_MIGRATION_LOCK = 727275;

/** Runs the fork migrations once (idempotent, advisory-locked across processes, one transaction per step). */
export async function migratePlex(pool: Pick<pg.Pool, 'connect'>): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('select pg_advisory_lock($1)', [PLEX_MIGRATION_LOCK]);
    await c.query('create table if not exists plex_schema_migrations (version int primary key, at timestamptz not null default now())');
    for (let i = 0; i < PLEX_MIGRATIONS.length; i++) {
      const done = await c.query('select 1 from plex_schema_migrations where version = $1', [i + 1]);
      if (done.rowCount) continue;
      await c.query('begin');
      try {
        await c.query(PLEX_MIGRATIONS[i]!);
        await c.query('insert into plex_schema_migrations(version) values ($1)', [i + 1]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    }
  } finally {
    await c.query('select pg_advisory_unlock($1)', [PLEX_MIGRATION_LOCK]).catch(() => undefined);
    c.release();
  }
}
