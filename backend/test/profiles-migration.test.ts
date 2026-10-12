import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/db.js';
import { TEST_DB } from './helpers.js';

describe('profiles migration', () => {
  const pool = new pg.Pool({ connectionString: TEST_DB, max: 2 });
  afterAll(() => pool.end());

  it('creates owner profiles (id == user id) and backfills profile_id on watchlist, thumbs, bookmarks, prefs', async () => {
    const last = MIGRATIONS.findIndex((m) => m.includes('create table profiles'));
    await pool.query('drop schema public cascade; create schema public;');
    for (const m of MIGRATIONS.slice(0, last)) await pool.query(m);
    const uid = '11111111-1111-4111-8111-111111111111';
    await pool.query("insert into users(id,authentik_sub,name,role,jellyfin_user_id,jellyfin_username,jellyfin_pw_enc) values ($1,'s','Eine sehr lange Anzeigename Person','member','jf','jfname','enc')", [uid]);
    const blank = '44444444-4444-4444-8444-444444444444';
    await pool.query("insert into users(id,authentik_sub,name,role,jellyfin_user_id,jellyfin_username,jellyfin_pw_enc) values ($1,'s2','','member','jf9','jfname9','enc')", [blank]);
    await pool.query("insert into watchlist(user_id,item_id) values ($1,'w1'),($1,'w2')", [uid]);
    await pool.query("insert into thumbs(user_id,item_id,value,item_name) values ($1,'t1',1,'T')", [uid]);
    await pool.query("insert into bookmarks(id,user_id,item_id,item_name,position_sec) values ('22222222-2222-4222-8222-222222222222',$1,'b1','B',5)", [uid]);
    await pool.query('insert into user_prefs(user_id,data) values ($1,$2)', [uid, JSON.stringify({ quality: 5 })]);

    await pool.query(MIGRATIONS[last]!);

    const p = (await pool.query('select * from profiles')).rows;
    expect(p).toHaveLength(2);
    expect(p.find((x) => x.id === blank)).toMatchObject({ is_owner: true, name: 'Profil' });
    expect(p.find((x) => x.id === uid)).toMatchObject({ id: uid, user_id: uid, is_owner: true, avatar: 'red', name: 'Eine sehr lange Anze' });
    expect((await pool.query('select profile_id from watchlist order by item_id')).rows.map((r) => r.profile_id)).toEqual([uid, uid]);
    expect((await pool.query('select profile_id from thumbs')).rows[0].profile_id).toBe(uid);
    expect((await pool.query('select profile_id from bookmarks')).rows[0].profile_id).toBe(uid);
    expect((await pool.query('select data from profile_prefs where profile_id=$1', [uid])).rows[0].data).toEqual({ quality: 5 });
    // a second profile may hold the same item independently
    await pool.query("insert into profiles(id,user_id,name,jellyfin_user_id) values ('33333333-3333-4333-8333-333333333333',$1,'Kind','jf2')", [uid]);
    await pool.query("insert into watchlist(profile_id,user_id,item_id) values ('33333333-3333-4333-8333-333333333333',$1,'w1')", [uid]);
    await expect(pool.query("insert into watchlist(profile_id,user_id,item_id) values ($1,$1,'w1')", [uid])).rejects.toThrow();
    // names are unique per account case-insensitively
    await expect(pool.query("insert into profiles(id,user_id,name,jellyfin_user_id) values ('55555555-5555-4555-8555-555555555555',$1,'KIND','jf3')", [uid])).rejects.toThrow();
  });

  it('migration 26 lets thumbs hold 2 ("Geliebt") and keeps existing rows', async () => {
    await pool.query('drop schema public cascade; create schema public;');
    for (const m of MIGRATIONS.slice(0, 25)) await pool.query(m);
    const uid = '11111111-1111-4111-8111-111111111111';
    await pool.query("insert into users(id,authentik_sub,name,role,jellyfin_user_id,jellyfin_username,jellyfin_pw_enc) values ($1,'s','A','member','jf','jfname','enc')", [uid]);
    await pool.query("insert into profiles(id,user_id,name,jellyfin_user_id,is_owner) values ($1,$1,'A','jf',true)", [uid]);
    await pool.query("insert into thumbs(profile_id,user_id,item_id,value,item_name) values ($1,$1,'a',1,'A'),($1,$1,'b',-1,'B')", [uid]);
    await expect(pool.query("insert into thumbs(profile_id,user_id,item_id,value,item_name) values ($1,$1,'c',2,'C')", [uid])).rejects.toThrow();
    await pool.query(MIGRATIONS[25]!);
    await pool.query("insert into thumbs(profile_id,user_id,item_id,value,item_name) values ($1,$1,'c',2,'C')", [uid]);
    await expect(pool.query("insert into thumbs(profile_id,user_id,item_id,value,item_name) values ($1,$1,'d',3,'D')", [uid])).rejects.toThrow();
    await expect(pool.query("insert into thumbs(profile_id,user_id,item_id,value,item_name) values ($1,$1,'e',0,'E')", [uid])).rejects.toThrow();
    expect((await pool.query('select item_id, value from thumbs order by item_id')).rows).toEqual([{ item_id: 'a', value: 1 }, { item_id: 'b', value: -1 }, { item_id: 'c', value: 2 }]);
    const checks = (await pool.query("select conname from pg_constraint where conrelid = 'thumbs'::regclass and contype = 'c'")).rows.map((r) => r.conname);
    expect(checks).toEqual(['thumbs_value_check']);
  });
});
