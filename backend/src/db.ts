// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';

export type Db = Pick<pg.Pool, 'query'>;

export const MIGRATIONS: string[] = [
  // 1: core
  `
  create table users (
    id uuid primary key,
    authentik_sub text unique not null,
    email text,
    name text not null,
    role text not null,
    jellyfin_user_id text not null,
    jellyfin_username text not null,
    jellyfin_pw_enc text not null,
    seerr_user_id integer,
    disabled boolean not null default false,
    created_at timestamptz not null default now()
  );
  create table audit_log (
    id bigserial primary key,
    at timestamptz not null default now(),
    actor uuid,
    action text not null,
    target text,
    meta jsonb not null default '{}'
  );
  create table watchlist (
    user_id uuid not null references users(id) on delete cascade,
    item_id text not null,
    added_at timestamptz not null default now(),
    primary key (user_id, item_id)
  );
  `,
  // 2: invites + devices
  `
  create table invites (
    id uuid primary key,
    token_hash text unique not null,
    role text not null,
    note text,
    expires_at timestamptz not null,
    used_at timestamptz,
    used_by uuid references users(id) on delete set null,
    created_by uuid references users(id) on delete set null,
    authentik_invite text,
    created_at timestamptz not null default now()
  );
  create table devices (
    user_id uuid not null references users(id) on delete cascade,
    device_id text not null,
    label text not null,
    approved boolean not null default false,
    created_at timestamptz not null default now(),
    last_seen timestamptz not null default now(),
    primary key (user_id, device_id)
  );
  `,
  // 3: seerr request mapping + notifications
  `
  create table seerr_requests (
    id bigserial primary key,
    seerr_request_id integer unique not null,
    user_id uuid not null references users(id) on delete cascade,
    media_type text not null,
    tmdb_id integer not null,
    title text not null,
    poster text,
    created_at timestamptz not null default now()
  );
  create table notifications (
    id bigserial primary key,
    user_id uuid references users(id) on delete cascade,
    kind text not null,
    title text not null,
    body text,
    link text,
    dedupe text unique,
    created_at timestamptz not null default now(),
    read_at timestamptz
  );
  create index notifications_user on notifications(user_id, created_at desc);
  `,
  // 4: polls, ratings, series follows
  `
  create table polls (
    id uuid primary key,
    title text not null,
    created_by uuid not null references users(id) on delete cascade,
    closes_at timestamptz not null,
    starts_at timestamptz not null,
    status text not null default 'open',
    winner_option_id bigint,
    room_id text,
    seerr_request_id integer,
    created_at timestamptz not null default now()
  );
  create table poll_options (
    id bigserial primary key,
    poll_id uuid not null references polls(id) on delete cascade,
    jf_item_id text,
    tmdb_id integer,
    media_type text,
    title text not null,
    poster text
  );
  create table poll_votes (
    poll_id uuid not null references polls(id) on delete cascade,
    user_id uuid not null references users(id) on delete cascade,
    option_id bigint not null references poll_options(id) on delete cascade,
    primary key (poll_id, user_id)
  );
  create table ratings (
    user_id uuid not null references users(id) on delete cascade,
    item_id text not null,
    item_name text not null,
    stars smallint not null check (stars between 1 and 5),
    review text,
    created_at timestamptz not null default now(),
    primary key (user_id, item_id)
  );
  create table series_follows (
    user_id uuid not null references users(id) on delete cascade,
    series_id text not null,
    series_name text not null,
    primary key (user_id, series_id)
  );
  `,
  // 5: watch statistics + achievements
  `
  create table play_seconds (
    user_id uuid not null references users(id) on delete cascade,
    item_id text not null,
    day date not null,
    seconds integer not null default 0,
    item_name text not null,
    item_type text,
    series_name text,
    primary key (user_id, item_id, day)
  );
  create table achievements (
    user_id uuid not null references users(id) on delete cascade,
    key text not null,
    earned_at timestamptz not null default now(),
    primary key (user_id, key)
  );
  `,
  // 6: viewing preferences
  `
  create table user_prefs (
    user_id uuid primary key references users(id) on delete cascade,
    data jsonb not null default '{}',
    updated_at timestamptz not null default now()
  );
  `,
  // 7: scene bookmarks, friend recommendations, thumbs
  `
  create table bookmarks (
    id uuid primary key,
    user_id uuid not null references users(id) on delete cascade,
    item_id text not null,
    item_name text not null,
    position_sec integer not null check (position_sec >= 0),
    note text,
    created_at timestamptz not null default now()
  );
  create index bookmarks_user_item on bookmarks(user_id, item_id);
  create table recommendations (
    id bigserial primary key,
    from_user uuid not null references users(id) on delete cascade,
    to_user uuid not null references users(id) on delete cascade,
    item_id text not null,
    item_name text not null,
    note text,
    seen boolean not null default false,
    created_at timestamptz not null default now()
  );
  create index recommendations_to on recommendations(to_user, created_at desc);
  create table thumbs (
    user_id uuid not null references users(id) on delete cascade,
    item_id text not null,
    value smallint not null check (value in (-1, 1)),
    item_name text not null,
    created_at timestamptz not null default now(),
    primary key (user_id, item_id)
  );
  `,
  // 8: per-user read marker for broadcast notifications
  `
  alter table users add column notifications_read_at timestamptz;
  `,
  // 9: atomic first-device auto-approval. Inside plpgsql every statement gets a fresh snapshot, so after the advisory lock
  // (held until the calling statement's implicit transaction ends) the not-exists sees a competitor's committed row.
  `
  create function register_device(p_user uuid, p_dev text, p_label text) returns boolean language plpgsql as $$
  declare v boolean;
  begin
    perform pg_advisory_xact_lock(hashtext(p_user::text));
    insert into devices(user_id, device_id, label, approved)
      select p_user, p_dev, p_label, not exists(select 1 from devices where user_id = p_user and approved)
      on conflict do nothing returning approved into v;
    return v;
  end $$;
  `,
  // preview clips: transcoded once, stored under PREVIEW_DIR
  `
  create table preview_clips (
    item_id text primary key,
    status text not null check (status in ('ok','failed')),
    bytes int,
    error text,
    created_at timestamptz not null default now()
  );
  `,
  // playback health check: last finished report
  `
  create table playback_checks (
    id serial primary key,
    started_at timestamptz not null,
    finished_at timestamptz not null,
    results jsonb not null
  );
  `,
  // preview clips: remember the audio language; drop clips built with random default tracks so the warmer rebuilds them
  `
  alter table preview_clips add column audio_lang text;
  delete from preview_clips;
  `,
  // monthly Seerr request limit per role. seerr_requests.source tells user wishes from admin-approved poll requests (those are not counted);
  // request_reservations holds a slot while Seerr is being called, reserve_request_slot takes it atomically (advisory lock per user).
  `
  create table role_settings (
    role text primary key,
    requests_per_month int check (requests_per_month between 0 and 100),
    updated_at timestamptz not null default now()
  );
  alter table seerr_requests add column source text not null default 'user' check (source in ('user','poll'));
  update seerr_requests set source='poll' where seerr_request_id in (select seerr_request_id from polls where seerr_request_id is not null);
  create index seerr_requests_user_month on seerr_requests(user_id, created_at) where source = 'user';
  create table request_reservations (
    id bigserial primary key,
    user_id uuid not null references users(id) on delete cascade,
    created_at timestamptz not null default now()
  );
  create function reserve_request_slot(p_user uuid, p_limit int) returns bigint language plpgsql as $$
  declare v bigint; n int;
  begin
    perform pg_advisory_xact_lock(hashtext('reqslot:' || p_user::text));
    delete from request_reservations where created_at < now() - interval '5 minutes';
    if p_limit is not null then
      select (select count(*) from seerr_requests where user_id = p_user and source = 'user' and created_at >= date_trunc('month', now()))
           + (select count(*) from request_reservations where user_id = p_user) into n;
      if n >= p_limit then return null; end if;
    end if;
    insert into request_reservations(user_id) values (p_user) returning id into v;
    return v;
  end $$;
  `,
  // admin-editable guest playback: per-role transcoding / max height overrides (null = keep template; max_height 0 = unlimited);
  // app_flags marks one-time startup jobs (reapplyPoliciesOnce).
  `
  alter table role_settings add column transcoding boolean;
  alter table role_settings add column max_height int check (max_height between 0 and 4320);
  create table app_flags (key text primary key, at timestamptz not null default now());
  `,
  // profiles. The owner profile has the same id as its account, so existing progress/token cache/device ids keep working.
  // Watchlist, thumbs and bookmarks become per profile (backfilled with the owner profile); profile_prefs holds per-profile viewing prefs.
  `
  create table profiles (
    id uuid primary key,
    user_id uuid not null references users(id) on delete cascade,
    name text not null check (char_length(name) between 1 and 20),
    avatar text not null default 'red',
    is_owner boolean not null default false,
    pin_hash text,
    jellyfin_user_id text,
    jellyfin_username text,
    jellyfin_pw_enc text,
    created_at timestamptz not null default now(),
    check (is_owner or jellyfin_user_id is not null)
  );
  create unique index profiles_user_name on profiles(user_id, lower(name));
  create unique index profiles_owner on profiles(user_id) where is_owner;
  insert into profiles(id, user_id, name, is_owner) select id, id, coalesce(nullif(btrim(left(name, 20)), ''), 'Profil'), true from users;
  alter table watchlist add column profile_id uuid references profiles(id) on delete cascade;
  update watchlist set profile_id = user_id;
  alter table watchlist alter column profile_id set not null;
  alter table watchlist drop constraint watchlist_pkey, add primary key (profile_id, item_id);
  alter table thumbs add column profile_id uuid references profiles(id) on delete cascade;
  update thumbs set profile_id = user_id;
  alter table thumbs alter column profile_id set not null;
  alter table thumbs drop constraint thumbs_pkey, add primary key (profile_id, item_id);
  alter table bookmarks add column profile_id uuid references profiles(id) on delete cascade;
  update bookmarks set profile_id = user_id;
  alter table bookmarks alter column profile_id set not null;
  create index bookmarks_profile_item on bookmarks(profile_id, item_id);
  create table profile_prefs (
    profile_id uuid primary key references profiles(id) on delete cascade,
    data jsonb not null default '{}',
    updated_at timestamptz not null default now()
  );
  insert into profile_prefs(profile_id, data) select user_id, data from user_prefs;
  create table resume_hidden (
    profile_id uuid not null references profiles(id) on delete cascade,
    item_id text not null,
    hidden_at timestamptz not null default now(),
    primary key (profile_id, item_id)
  );
  `,
  // 16: weekly digest
  `
  create table digests (
    user_id uuid not null references users(id) on delete cascade,
    week date not null,
    sent_at timestamptz not null default now(),
    data jsonb not null,
    primary key (user_id, week)
  );
  create table app_settings (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
  `,
  // 17: shared lists
  `
  create table lists (
    id uuid primary key,
    owner_id uuid not null references users(id) on delete cascade,
    name text not null check (char_length(name) between 1 and 60),
    description text check (char_length(description) <= 280),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create index lists_owner on lists(owner_id);
  create table list_members (
    list_id uuid not null references lists(id) on delete cascade,
    user_id uuid not null references users(id) on delete cascade,
    role text not null check (role in ('editor','viewer')),
    added_at timestamptz not null default now(),
    primary key (list_id, user_id)
  );
  create index list_members_user on list_members(user_id);
  create table list_items (
    list_id uuid not null references lists(id) on delete cascade,
    item_id text not null,
    item_name text not null,
    note text check (char_length(note) <= 140),
    added_by uuid references users(id) on delete set null,
    added_at timestamptz not null default now(),
    primary key (list_id, item_id)
  );
  `,
  // 18: "Erinnere mich" reminders
  `
  create table reminders (
    id bigserial primary key,
    user_id uuid not null references users(id) on delete cascade,
    profile_id uuid references profiles(id) on delete set null,
    kind text not null check (kind in ('tmdb','episode')),
    media_type text check (media_type in ('movie','tv')),
    tmdb_id int,
    jf_item_id text,
    series_id text,
    season int,
    episode int,
    title text not null,
    poster text,
    release_date date,
    created_at timestamptz not null default now(),
    fired_at timestamptz,
    check ((kind='tmdb' and tmdb_id is not null and media_type is not null) or (kind='episode' and jf_item_id is not null))
  );
  create unique index reminders_tmdb on reminders(user_id, media_type, tmdb_id) where kind='tmdb';
  create unique index reminders_ep on reminders(user_id, jf_item_id) where kind='episode';
  create index reminders_open on reminders(kind) where fired_at is null;
  `,
  // 19: Web Push subscriptions (one per browser/device)
  `
  create table push_subscriptions (
    id bigserial primary key,
    user_id uuid not null,
    device_id text not null,
    profile_id uuid not null references profiles(id) on delete cascade,
    endpoint text not null unique check (char_length(endpoint) <= 1024),
    p256dh text not null check (char_length(p256dh) <= 200),
    auth text not null check (char_length(auth) <= 64),
    broadcast boolean not null default false,
    created_at timestamptz not null default now(),
    last_ok_at timestamptz,
    fail_count int not null default 0,
    foreign key (user_id, device_id) references devices(user_id, device_id) on delete cascade
  );
  create index push_subscriptions_user on push_subscriptions(user_id);
  `,
  // 20: offline downloads (licenses per device + shared prepared files)
  `
  alter table role_settings
    add column download boolean,
    add column max_downloads int check (max_downloads between 0 and 200),
    add column download_max_height int check (download_max_height between 0 and 2160),
    add column download_days int check (download_days between 1 and 90);
  create table download_jobs (
    id uuid primary key,
    item_id text not null,
    quality text not null check (quality in ('sd','hd','fhd','original')),
    audio_lang text not null default '',
    -- effective caps the file was prepared with (role height/bitrate clamp); part of the job key so roles with different caps never share a file
    max_height int not null default 0,
    max_bitrate int not null default 0,
    media_source_id text,
    status text not null check (status in ('queued','preparing','ready','failed')),
    seg_done int not null default 0,
    seg_total int,
    init_sha text,
    bytes bigint,
    error text,
    play_session_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    last_used_at timestamptz not null default now()
  );
  create unique index download_jobs_key on download_jobs(item_id, quality, audio_lang, max_height, max_bitrate) where status <> 'failed';
  create table downloads (
    id uuid primary key,
    user_id uuid not null,
    device_id text not null,
    profile_id uuid not null references profiles(id) on delete cascade,
    item_id text not null,
    job_id uuid references download_jobs(id) on delete set null,
    quality text not null,
    status text not null check (status in ('pending','fetched','deleted','revoked')),
    created_at timestamptz not null default now(),
    fetched_at timestamptz,
    expires_at timestamptz not null,
    checked_at timestamptz not null default now(),
    progress_at timestamptz,
    subs jsonb not null default '[]',
    meta jsonb not null default '{}',
    foreign key (user_id, device_id) references devices(user_id, device_id) on delete cascade
  );
  create unique index downloads_dev_item on downloads(user_id, device_id, profile_id, item_id) where status in ('pending','fetched');
  create index downloads_user_active on downloads(user_id) where status in ('pending','fetched');
  `,
  // 21: indexes for per-item ratings and per-user thumbs lookups
  `
  create index if not exists ratings_item on ratings(item_id);
  create index if not exists thumbs_user on thumbs(user_id);
  `,
  // 22: library audio/subtitle language index (filled by langindex.ts) and per-profile "dropped" titles
  `
  create table item_langs (
    item_id text primary key,
    type text not null,
    audio text[] not null default '{}',
    subs text[] not null default '{}',
    indexed_at timestamptz not null default now()
  );
  create index item_langs_audio on item_langs using gin(audio);
  create index item_langs_subs on item_langs using gin(subs);
  create table dropped (
    profile_id uuid not null references profiles(id) on delete cascade,
    item_id text not null,
    dropped_at timestamptz not null default now(),
    primary key (profile_id, item_id)
  );
  `,
  // 23: spoiler-gated reactions to watched movies/episodes
  `
  create table reactions (
    user_id uuid not null references users(id) on delete cascade,
    item_id text not null,
    emoji text not null check (emoji in ('like','funny','wow','sad','love')),
    comment text check (char_length(comment) <= 280),
    created_at timestamptz not null default now(),
    primary key (user_id, item_id)
  );
  create index reactions_item on reactions(item_id);
  `,
  // 24: curated ("featured") lists shown on everyone's home page
  `
  alter table lists add column featured_at timestamptz;
  create index lists_featured on lists(featured_at) where featured_at is not null;
  `,
  // 25: reactions belong to a profile (the "watched" gate is per profile); owner profile id = user id
  `
  alter table reactions add column profile_id uuid references profiles(id) on delete cascade;
  update reactions set profile_id = user_id;
  alter table reactions alter column profile_id set not null;
  alter table reactions drop constraint reactions_pkey;
  alter table reactions add primary key (profile_id, item_id);
  `,
  // 26: thumbs get a third value 2 ("Geliebt"); the inline check was auto-named thumbs_value_check, but drop whatever check guards value
  `
  do $$
  declare c record;
  begin
    for c in select conname from pg_constraint
              where conrelid = 'thumbs'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%value%'
    loop
      execute format('alter table thumbs drop constraint %I', c.conname);
    end loop;
  end $$;
  alter table thumbs add constraint thumbs_value_check check (value in (-1, 1, 2));
  `,
  // 27: notifications keep their message keys + params (i18n.ts Text) so the inbox renders them in the reader's language
  `
  alter table notifications add column msg jsonb;
  `,
  // 28: Block 15 Q1: brand hubs (admin-defined tiles on the home page; source = Jellyfin studio | collection | tag | genre)
  `
  create table brand_hubs (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    source_kind text not null check (source_kind in ('studio','collection','tag','genre')),
    source_value text not null,
    accent text,
    image_item_id text,
    image_kind text check (image_kind in ('Primary','Backdrop')),
    sort_order int not null default 0,
    enabled boolean not null default true,
    created_at timestamptz not null default now()
  );
  create index brand_hubs_order on brand_hubs (sort_order, created_at);
  `,
  // 29: per profile + series audio / subtitle language ("anime pack"); null = not chosen, subtitle 'off' = subtitles off
  `
  create table series_langprefs (
    profile_id uuid not null references profiles(id) on delete cascade,
    series_id text not null,
    audio text check (char_length(audio) <= 16),
    subtitle text check (char_length(subtitle) <= 16),
    updated_at timestamptz not null default now(),
    primary key (profile_id, series_id)
  );
  `,
  // 30: friends-only comments on episodes / movies (soft delete; the reader's own watched state decides the spoiler blur)
  `
  create table episode_comments (
    id uuid primary key default gen_random_uuid(),
    item_id text not null,
    profile_id uuid not null references profiles(id) on delete cascade,
    user_id uuid not null references users(id) on delete cascade,
    body text not null check (char_length(body) between 1 and 1000),
    spoiler boolean not null default true,
    created_at timestamptz not null default now(),
    deleted_at timestamptz
  );
  create index episode_comments_item on episode_comments(item_id, created_at desc) where deleted_at is null;
  create index episode_comments_profile on episode_comments(profile_id, created_at);
  `,
  // 31: Block 15 K1: kids profiles (Jellyfin parental cap 0/6/12 on the profile's hidden Jellyfin user), a device that last ran a
  // kids profile stays on it (switching away needs a PIN), onboarding flag: every profile that exists now counts as onboarded
  `
  alter table profiles add column kids boolean not null default false;
  alter table profiles add column kids_max_rating smallint not null default 12 check (kids_max_rating in (0, 6, 12));
  alter table devices add column kids_profile_id uuid references profiles(id) on delete set null;
  insert into profile_prefs(profile_id, data) select id, '{"onboarded": true}'::jsonb from profiles
    on conflict (profile_id) do update set data = profile_prefs.data || '{"onboarded": true}'::jsonb;
  `,
  // 32: Block 17 D1 – "leaving soon" dates set by admins (nothing is deleted on the media server) + quality index (4K / HDR browse filter)
  `
  create table leaving_soon (
    item_id text primary key,
    leaves_at date not null,
    note text,
    set_by uuid references users(id) on delete set null,
    created_at timestamptz not null default now()
  );
  create index leaving_soon_at on leaving_soon(leaves_at);
  create table item_quality (
    item_id text primary key,
    type text not null,
    res text not null,
    hdr text,
    audio text,
    indexed_at timestamptz not null default now()
  );
  create index item_quality_res on item_quality(res);
  `,
  // 33: Block 17 S1: themed lists ("Themenliste": the owner marks a list as editorial, optional emoji + cover colour; featured themed
  // lists are ordered on the home page by featured_pos). Calm mode is a profile pref (profile_prefs.data), no column needed.
  `
  alter table lists add column themed boolean not null default false;
  alter table lists add column emoji text check (emoji is null or char_length(emoji) <= 16);
  alter table lists add column cover_color text check (cover_color is null or cover_color ~ '^#[0-9a-fA-F]{6}$');
  alter table lists add column featured_pos int;
  create index lists_themed on lists(themed) where themed;
  `,
  // 34: per-role bitrate cap for viewers outside the home networks (null = role default)
  `
  alter table role_settings add column remote_max_bitrate int check (remote_max_bitrate between 300000 and 200000000);
  `,
  // 35: Block 22 admin care: streams/transcodes per user, day and device; library hygiene facts + ignored issues; dismissed
  // health banner issues per admin (until the issue's level or reason changes)
  `
  create table play_daily (
    user_id uuid not null references users(id) on delete cascade,
    day date not null,
    device_id text not null default '',
    streams int not null default 0,
    transcodes int not null default 0,
    reasons jsonb not null default '{}',
    primary key (user_id, day, device_id)
  );
  create index play_daily_day on play_daily(day);
  create table hygiene_items (
    item_id text primary key,
    type text not null check (type in ('Movie','Series','Episode')),
    name text not null,
    series_id text,
    series_name text,
    year int,
    facts jsonb not null,
    issues text[] not null default '{}',
    ids_key text,
    title_key text,
    episode_key text,
    scanned_at timestamptz not null default now()
  );
  create index hygiene_items_issues on hygiene_items using gin(issues);
  create index hygiene_items_type on hygiene_items(type);
  create index hygiene_items_series on hygiene_items(series_id) where series_id is not null;
  create index hygiene_items_ids on hygiene_items(ids_key) where ids_key is not null;
  create index hygiene_items_title on hygiene_items(title_key) where title_key is not null;
  create index hygiene_items_episode on hygiene_items(episode_key) where episode_key is not null;
  create table hygiene_ignored (
    item_id text not null,
    code text not null,
    by_user uuid references users(id) on delete set null,
    at timestamptz not null default now(),
    primary key (item_id, code)
  );
  create table health_dismissals (
    user_id uuid not null references users(id) on delete cascade,
    issue_id text not null,
    fp text not null,
    at timestamptz not null default now(),
    primary key (user_id, issue_id)
  );
  `,
  // 36: player start-time measurements (playtiming.ts): anonymous on purpose (no user / profile / item / address), kept 14 days
  `
  create table playback_timings (
    id bigserial primary key,
    created_at timestamptz not null default now(),
    home boolean not null,
    device text not null check (device in ('phone','pc','tv')),
    mode text check (mode in ('direct','hls')),
    quality_switch boolean not null default false,
    bitrate int,
    target_duration real,
    info_ms int,
    manifest_ms int,
    first_frag_ms int,
    first_frag_bytes int,
    first_frag_dl_ms int,
    first_frame_ms int,
    seeks int not null default 0,
    seek_median_ms int,
    seek_max_ms int,
    stalls int not null default 0,
    stall_ms int not null default 0,
    effective_type text
  );
  create index playback_timings_created on playback_timings(created_at);
  `,
  // 37: Block 23 user management (access expiry, per-user limits, approval queue, multi-use invites)
  `
  alter table users
    add column access_until timestamptz,
    add column expiry_notified_at timestamptz,
    add column locked_reason text,
    add column deletion_at timestamptz,
    add column avatar text;
  create table user_limits (
    user_id uuid primary key references users(id) on delete cascade,
    max_streams int,
    remote_bitrate int,
    max_downloads int,
    download_max_height int,
    requests_per_month int,
    updated_at timestamptz default now()
  );
  create table approval_requests (
    id uuid primary key,
    authentik_sub text unique not null,
    email text,
    name text not null,
    requested_at timestamptz default now(),
    notified_at timestamptz,
    rejected_at timestamptz,
    reject_message text
  );
  alter table invites
    add column max_uses int not null default 1,
    add column uses int not null default 0,
    add column access_days int;
  create table invite_uses (
    invite_id uuid references invites(id) on delete cascade,
    user_id uuid references users(id) on delete cascade,
    at timestamptz default now(),
    primary key (invite_id, user_id)
  );
  update invites set uses = 1 where used_at is not null;
  insert into invite_uses(invite_id, user_id, at)
    select id, used_by, used_at from invites where used_by is not null;
  `,
  // 38: Block 23 phase 2 account deletion: the tombstone of a claimed deletion (snapshot for the later steps; no FK, the users row
  // is deleted in step 4; the personal fields are nulled when finished, the pseudonym stays for the audit views) + due lookup
  `
  create table account_deletions (
    user_id uuid primary key,
    pseudonym text not null,
    step int not null default 0,
    authentik_sub text,
    jellyfin_ids text[],
    seerr_user_id int,
    name text,
    email text,
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    last_error text,
    failed_step int
  );
  create index account_deletions_sub on account_deletions(authentik_sub) where finished_at is null;
  create index users_deletion_at on users(deletion_at) where deletion_at is not null;
  `,
  // 39: Block 25 settings store. settings holds admin/wizard-set config keys (plain JSON value, or an AES-256-GCM blob for secrets);
  // settings_meta.rev is bumped by every write so instances reload. An install with users counts as set up (never sees the wizard).
  // The data-source keys move over from app_settings unchanged (same APP_ENC_KEY, same blob format); a malformed row (no string enc)
  // is dropped instead of failing the migration.
  `
  create table settings (
    key text primary key,
    value jsonb,
    enc text,
    last4 text,
    updated_at timestamptz not null default now(),
    updated_by uuid references users(id) on delete set null,
    check ((value is null) <> (enc is null))
  );
  create table settings_meta (
    id int primary key check (id = 1),
    rev bigint not null default 0,
    setup_completed_at timestamptz,
    setup_code_hash text,
    setup_code_expires_at timestamptz,
    setup_code_failures int not null default 0
  );
  insert into settings_meta(id, setup_completed_at)
    select 1, case when exists (select 1 from users) then now() end;
  insert into settings(key, enc, last4, updated_at)
    select case key when 'source.tmdb' then 'TMDB_API_KEY' else 'OMDB_API_KEY' end, value->>'enc', value->>'last4', updated_at
    from app_settings where key in ('source.tmdb','source.omdb') and value ? 'enc' and jsonb_typeof(value->'enc') = 'string';
  delete from app_settings where key in ('source.tmdb','source.omdb');
  `,
  // 40: Block 25b. An install that got migration 39 while it had no users yet, and its first users afterwards (before the setup wizard
  // existed), counts as set up as well: it must never fall into setup mode. An empty install stays in setup.
  `
  update settings_meta set setup_completed_at = now() where setup_completed_at is null and exists (select 1 from users);
  `,
  // 41: R1 recommendation index (reco/indexJob.ts): library metadata features per film / series, IDF weights and numeric statistics.
  // Library facts only (no user data, no paths or URLs); rebuilt from the media server, so it can always be dropped and refilled.
  `
  create table item_features (
    item_id text primary key,
    type text not null check (type in ('Movie','Series')),
    genres text[] not null default '{}',
    tags text[] not null default '{}',
    studios text[] not null default '{}',
    people text[] not null default '{}',
    year int,
    runtime_min int,
    community_rating real,
    critic_rating real,
    original_language text,
    countries text[] not null default '{}',
    collection_id text,
    series_status text check (series_status in ('continuing','ended')),
    overview_terms jsonb not null default '{}',
    updated_at timestamptz not null default now()
  );
  create index item_features_collection on item_features(collection_id) where collection_id is not null;
  create index item_features_genres on item_features using gin(genres);
  create table item_feature_idf (
    kind text not null check (kind in ('genre','tag','studio','person','term')),
    value text not null,
    df int not null,
    idf real not null,
    seen_at timestamptz not null default now(),
    primary key (kind, value)
  );
  create table item_feature_stats (
    name text primary key,
    mean double precision not null,
    std double precision not null,
    n int not null
  );
  `,
];

export async function migrate(pool: pg.Pool): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('select pg_advisory_lock(727274)');
    await c.query('create table if not exists schema_migrations (version int primary key, at timestamptz not null default now())');
    for (let i = 0; i < MIGRATIONS.length; i++) {
      const done = await c.query('select 1 from schema_migrations where version = $1', [i + 1]);
      if (done.rowCount) continue;
      await c.query('begin');
      try {
        await c.query(MIGRATIONS[i]!);
        await c.query('insert into schema_migrations(version) values ($1)', [i + 1]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    }
  } finally {
    await c.query('select pg_advisory_unlock(727274)').catch(() => undefined);
    c.release();
  }
}
