import { createECDH, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digestPushText, digestText, type DigestData } from '../src/digest.js';
import { deviceLabel } from '../src/devices.js';
import { LANGUAGES, LANGUAGE_TAGS, knownText, m, msg, render, renderKnown, roleLabel } from '../src/i18n.js';
import { CATALOGS, type Message } from '../src/messages.js';
import { localizeStored, notify } from '../src/notify.js';
import { buildPayload, sendWebPush } from '../src/push.js';
import { ADMIN, makeEnv, type TestEnv } from './helpers.js';

const placeholders = (v: Message) => new Set((typeof v === 'string' ? [v] : Object.values(v)).flatMap((s) => [...(s as string).matchAll(/\{(\w+)\}/g)].map((x) => x[1])));

describe('backend message catalogs', () => {
  const de = CATALOGS.de as Record<string, Message>;
  for (const lang of LANGUAGES) {
    it(`${lang}: every key, same placeholders, valid plural forms`, () => {
      const cat = CATALOGS[lang] as Record<string, Message>;
      expect(Object.keys(cat).sort()).toEqual(Object.keys(de).sort());
      const cats = new Intl.PluralRules(LANGUAGE_TAGS[lang]).resolvedOptions().pluralCategories as string[];
      for (const [key, src] of Object.entries(de)) {
        const v = cat[key]!;
        expect(typeof v, key).toBe(typeof src);
        expect([...placeholders(v)].sort(), `${lang} ${key}`).toEqual([...placeholders(src)].sort());
        if (typeof v === 'object') {
          for (const c of Object.keys(v)) expect(['zero', ...cats], `${lang} ${key}.${c}`).toContain(c);
          for (const c of cats) expect(v, `${lang} ${key} needs "${c}"`).toHaveProperty(c);
        }
        if (lang !== 'de' && typeof v === 'string') expect(v.trim(), `${lang} ${key}`).not.toBe('');
      }
    });
  }
});

describe('rendering', () => {
  it('plural forms per language, numbers, nested messages, joins, dates, fallbacks', () => {
    expect(msg('de', 'digest.movies', { n: 1 })).toBe('1 neuer Film');
    expect(msg('en', 'digest.movies', { n: 2 })).toBe('2 new movies');
    expect(msg('pl', 'digest.movies', { n: 1 })).toBe('1 nowy film');
    expect(msg('pl', 'digest.movies', { n: 3 })).toBe('3 nowe filmy');
    expect(msg('pl', 'digest.movies', { n: 5 })).toBe('5 nowych filmów');
    expect(msg('pl', 'digest.movies', { n: 22 })).toBe('22 nowe filmy');
    expect(msg('fr', 'digest.movies', { n: 1_000_000 })).toBe('1 000 000 nouveaux films');
    expect(msg('de', 'more', { list: 'A, B', n: 1234 })).toBe('A, B und 1.234 weitere');
    expect(render('en', m('achievement.unlocked', { name: m('ach.night_owl.title') }))).toBe('Achievement unlocked: Night owl');
    expect(render('it', { join: [m('digest.movies', { n: 1 }), '', 'frei'], sep: ' | ' })).toBe('1 nuovo film | frei');
    expect(render('en', m('poll.start', { when: { date: '2026-10-12T18:30:00Z' } }))).toMatch(/^Starts: 12 Oct 2026, \d\d:30$/);
    expect(msg('en', 'nope.key')).toBe('nope.key');
    expect(msg('en', 'title.available')).toBe('“{title}” is now available'); // a missing param stays visible
    expect(render('de', { bogus: true } as never)).toBe('');
    expect(render('de', null)).toBe('');
  });

  it('labels: devices, roles (customised labels stay), stored notifications', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120';
    expect(deviceLabel(ua)).toBe('Chrome auf Linux');
    expect(deviceLabel(ua, 'en')).toBe('Chrome on Linux');
    expect(deviceLabel('curl/8', 'fr')).toBe('Browser sur appareil');
    expect(roleLabel('tr', 'guest', 'Gast', 'Gast')).toBe('Misafir');
    expect(roleLabel('en', 'guest', 'Besucher', 'Gast')).toBe('Besucher');
    expect(roleLabel('en', 'vip', 'VIP', undefined)).toBe('VIP');
    const row = { id: 1, title: 'Download bereit', body: null, msg: { title: m('download.ready.title'), body: m('download.ready.body', { title: 'Dune' }) } };
    expect(localizeStored(row, 'es')).toEqual({ id: 1, title: 'Descarga lista', body: 'Dune ya se puede descargar.' });
    expect(localizeStored({ id: 2, title: 'alt', body: 'text', msg: null }, 'en')).toEqual({ id: 2, title: 'alt', body: 'text' });
  });

  it('inbox rows that refer to renamed/removed keys keep the stored text instead of showing the raw key', () => {
    const gone = { key: 'download.renamed.title' } as unknown as ReturnType<typeof m>;
    const nested = m('download.ready.body', { title: { key: 'old.removed.key' } as unknown as ReturnType<typeof m> });
    const row = { id: 3, title: 'Download bereit', body: 'Dune kann jetzt geladen werden.', msg: { title: gone, body: nested } };
    expect(localizeStored(row, 'en')).toEqual({ id: 3, title: 'Download bereit', body: 'Dune kann jetzt geladen werden.' });
    expect(knownText(gone)).toBe(false);
    expect(knownText(nested)).toBe(false);
    expect(knownText({ join: [m('download.ready.title'), 'plain'] })).toBe(true);
    expect(renderKnown('en', m('download.ready.title'))).toBe('Download ready');
    expect(renderKnown('en', { join: [gone] })).toBeNull();
    // a known title next to an unknown body: only the body falls back
    expect(localizeStored({ ...row, msg: { title: m('download.ready.title'), body: gone } }, 'en')).toEqual({ id: 3, title: 'Download ready', body: 'Dune kann jetzt geladen werden.' });
  });

  it('weekly digest texts', () => {
    const d: DigestData = {
      since: '', until: '', newMovies: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }, { id: '3', name: 'C' }], newMovieCount: 5,
      newEpisodes: [{ seriesId: 's', seriesName: 'Serie', count: 3, followed: true, episodes: [] }], newEpisodeCount: 3, seriesCounts: { s: 3, t: 1 },
      available: [{ title: 'x', link: null, itemId: null }], recommendations: [],
    };
    const de = digestText(d);
    expect(render('de', de.title)).toBe('Dein Wochenrückblick: 5 neue Filme, 3 neue Folgen');
    expect(render('de', de.body)).toBe('5 neue Filme\n3 neue Folgen in 2 Serien, davon 1 von deinen Serien\n1 Wunsch ist jetzt verfügbar');
    expect(render('en', de.title)).toBe('Your weekly recap: 5 new movies, 3 new episodes');
    expect(render('pl', de.body).split('\n')[0]).toBe('5 nowych filmów');
    expect(render('de', digestPushText(d))).toBe('Filme: A, B, C und 2 weitere\nDeine Serien: Serie (3)\n1 Wunsch ist jetzt verfügbar');
    expect(render('en', digestPushText(d)).split('\n')[0]).toBe('Movies: A, B, C and 2 more');
  });
});

type Sess = { cookies: Record<string, string>; csrf: string };
const vapid = webpush.generateVAPIDKeys();
const FCM = 'https://fcm.googleapis.com/fcm/send/';
let env: TestEnv;
let admin: Sess;
let adminId: string;
const ntfy: Array<{ title: string; body: string }> = [];
const call = (s: Sess, method: string, url: string, body?: unknown) =>
  env.app.inject({ method: method as 'GET', url, cookies: s.cookies, headers: { 'x-csrf-token': s.csrf }, payload: body as object });

beforeAll(async () => {
  env = await makeEnv({}, {
    ctxPatch: (c) => {
      c.cfg = { ...c.cfg, VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, NTFY_URL: 'https://ntfy.example.com/ff' };
      c.fetchImpl = (async (url: string, init?: RequestInit) => {
        if (String(url).startsWith('https://ntfy.example.com/')) ntfy.push({ title: decodeURIComponent(String((init?.headers as Record<string, string>).Title)), body: String(init?.body) });
        return new Response(null, { status: 201 });
      }) as unknown as typeof fetch;
    },
  });
  admin = await env.login(ADMIN);
  adminId = (await env.pool.query("select id from users where authentik_sub='sub-admin'")).rows[0].id;
});
afterAll(async () => { await env.close(); });

describe('notifications in the recipient language', () => {
  it('inbox: stored in the account language, shown in the reader language; broadcasts + ntfy in the instance language', async () => {
    await call(admin, 'PUT', '/api/prefs/language', { language: 'en' });
    await notify(env.ctx, { userId: adminId, kind: 'download_ready', title: m('download.ready.title'), body: m('download.ready.body', { title: 'Dune' }), link: '/downloads' });
    const stored = (await env.pool.query("select title, body, msg from notifications where kind='download_ready'")).rows[0];
    expect(stored).toMatchObject({ title: 'Download ready', body: 'Dune can be downloaded now.' });
    expect(stored.msg.title).toEqual({ key: 'download.ready.title' });

    await call(admin, 'PUT', '/api/prefs/language', { language: 'fr' });
    let inbox = (await call(admin, 'GET', '/api/notifications')).json().notifications;
    expect(inbox[0]).toMatchObject({ title: 'Téléchargement prêt', body: 'Dune peut maintenant être téléchargé.', link: '/downloads' });
    expect(inbox[0].msg).toBeUndefined();

    await call(admin, 'PUT', '/api/admin/settings/language', { language: 'es' });
    await notify(env.ctx, { userId: null, kind: 'poll_open', title: m('poll.open', { title: 'Kino' }), external: true, dedupe: 'i18n-poll' });
    expect((await env.pool.query("select title from notifications where kind='poll_open'")).rows[0].title).toBe('Votación de la noche de cine: Kino');
    expect(ntfy.at(-1)).toEqual({ title: 'Votación de la noche de cine: Kino', body: 'Votación de la noche de cine: Kino' });
    inbox = (await call(admin, 'GET', '/api/notifications')).json().notifications;
    expect(inbox[0].title).toBe('Vote pour la soirée cinéma : Kino'); // the reader's language, not the instance's

    // plain strings (old rows, people's notes) stay as they are
    await notify(env.ctx, { userId: adminId, kind: 'recommend', title: m('recommend', { name: 'Bea', title: 'Up' }), body: 'Unbedingt schauen!' });
    inbox = (await call(admin, 'GET', '/api/notifications')).json().notifications;
    expect(inbox[0]).toMatchObject({ title: 'Bea vous recommande « Up »', body: 'Unbedingt schauen!' });
    await call(admin, 'PUT', '/api/admin/settings/language', { language: 'de' });
  });

  it('web push: each subscription in its profile language, neutral text for other profiles', async () => {
    expect(buildPayload({ kind: 'k', title: m('push.generic') }, true, 'tr').title).toBe('Yeni bildirim');
    const orig = webpush.generateRequestDetails;
    const payloads: Array<Record<string, string>> = [];
    (webpush as { generateRequestDetails: unknown }).generateRequestDetails = (s: unknown, p: string, o: unknown) => { payloads.push(JSON.parse(p)); return orig.call(webpush, s as never, p, o as never); };
    try {
      await call(admin, 'PUT', '/api/prefs/language', { language: 'it' });
      const kid = (await call(admin, 'POST', '/api/profiles', { name: 'Kind' })).json().profile.id as string;
      await env.pool.query("insert into profile_prefs(profile_id, data) values ($1, '{\"language\":\"pl\"}') on conflict (profile_id) do update set data = excluded.data", [kid]);
      const dev = (await env.pool.query('select device_id from devices where user_id=$1', [adminId])).rows[0].device_id;
      for (const [id, prof] of [['own', adminId], ['kid', kid]] as const) {
        const e = createECDH('prime256v1'); e.generateKeys();
        await env.pool.query('insert into push_subscriptions(user_id, device_id, profile_id, endpoint, p256dh, auth) values ($1,$2,$3,$4,$5,$6)', [adminId, dev, prof, FCM + id, e.getPublicKey().toString('base64url'), randomBytes(16).toString('base64url')]);
      }
      await sendWebPush(env.ctx, { userId: adminId, kind: 'tv_paired', title: m('tv.paired.title'), body: m('tv.paired.body') });
      expect(payloads).toHaveLength(2);
      expect(payloads).toContainEqual(expect.objectContaining({ title: 'Una TV è stata collegata al tuo account', body: 'Non sei stato tu? Blocca il dispositivo in «Dispositivi».' }));
      expect(payloads).toContainEqual(expect.objectContaining({ title: 'FriendFlix', body: 'Nowe powiadomienie' }));
    } finally {
      (webpush as { generateRequestDetails: unknown }).generateRequestDetails = orig;
    }
  });

  it('role labels: /api/me in the profile language, invite page in ?lang or the instance language', async () => {
    await call(admin, 'PUT', '/api/prefs/language', { language: 'en' });
    expect((await call(admin, 'GET', '/api/me')).json().roleLabel).toBe('Admin');
    const token = (await call(admin, 'POST', '/api/admin/invites', { role: 'guest', ttlHours: 1 })).json().link.split('/').pop();
    expect((await env.app.inject(`/api/invite/${token}`)).json().roleLabel).toBe('Gast');
    expect((await env.app.inject(`/api/invite/${token}?lang=tr`)).json().roleLabel).toBe('Misafir');
    expect((await env.app.inject(`/api/invite/${token}?lang=xx`)).json().roleLabel).toBe('Gast');
    // the anonymous page also learns the instance default (a new invitee without a stored language sees it in that one)
    expect((await env.app.inject(`/api/invite/${token}?lang=tr`)).json().defaultLanguage).toBe('de');
    await call(admin, 'PUT', '/api/admin/settings/language', { language: 'fr' });
    expect((await env.app.inject(`/api/invite/${token}`)).json()).toMatchObject({ roleLabel: 'Invité', defaultLanguage: 'fr' });
    // a fresh TV (no stored UI language) learns the instance default from its pairing code answer
    expect((await env.app.inject({ method: 'POST', url: '/api/tv/code' })).json()).toMatchObject({ defaultLanguage: 'fr' });
  });

  it('admin roles: builtinLabel only for labels equal to the built-in default (ROLES_JSON renames stay as configured)', async () => {
    const orig = env.ctx.roles;
    env.ctx.roles = { ...orig, guest: { ...orig.guest!, label: 'Besucher' }, vip: { ...orig.friend!, label: 'VIP' } };
    try {
      const r = (await call(admin, 'GET', '/api/admin/roles')).json();
      expect(r.roles.friend).toMatchObject({ label: 'Freund', builtinLabel: true });
      expect(r.roles.guest).toMatchObject({ label: 'Besucher', builtinLabel: false });
      expect(r.roles.vip).toMatchObject({ label: 'VIP', builtinLabel: false });
      const lim = Object.fromEntries((r.limits as Array<{ role: string; builtinLabel: boolean }>).map((x) => [x.role, x.builtinLabel]));
      expect(lim).toMatchObject({ friend: true, family: true, admin: true, guest: false, vip: false });
    } finally { env.ctx.roles = orig; }
  });
});
