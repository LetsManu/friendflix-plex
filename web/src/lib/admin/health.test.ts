// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { hasKey } from '#lib/i18n';
import { REASONS, SERVICE_IDS, TC_REASONS, cleanCode, diskLabelKey, emptyHintOnTop, isEmptyMediaError, levelTone, reasonKey, serviceText, sortServices, tcKey, type ServiceHealth } from './health';

describe('health view helpers', () => {
  it('levelTone maps all four levels', () => {
    expect(levelTone('ok')).toBe('ok');
    expect(levelTone('warn')).toBe('warn');
    expect(levelTone('err')).toBe('err');
    expect(levelTone('off')).toBe('muted');
  });

  it('sortServices puts err before warn before ok before off and keeps the order inside a level', () => {
    const s: ServiceHealth[] = [
      { id: 'tmdb', level: 'off' }, { id: 'postgres', level: 'ok' }, { id: 'requests', level: 'warn', reason: 'down' },
      { id: 'media', level: 'err', reason: 'down' }, { id: 'redis', level: 'ok' }, { id: 'omdb', level: 'warn', reason: 'budget' },
    ];
    expect(sortServices(s).map((x) => x.id)).toEqual(['media', 'requests', 'omdb', 'postgres', 'redis', 'tmdb']);
    expect(s[0]!.id).toBe('tmdb'); // input untouched
  });

  it('reasonKey covers every Reason with an existing text (exhaustive)', () => {
    for (const r of REASONS) {
      expect(hasKey(reasonKey('svc:media', r)), r).toBe(true);
      expect(hasKey(reasonKey('disk:downloads', r)), r).toBe(true);
    }
  });

  it('every service, transcode reason and disk has a label', () => {
    for (const id of SERVICE_IDS) expect(hasKey(`adminContent.health.svc.${id}`), id).toBe(true);
    for (const r of TC_REASONS) expect(hasKey(tcKey(r)), r).toBe(true);
    for (const d of ['downloads', 'previews', 'database'] as const) expect(hasKey(diskLabelKey({ id: d, level: 'ok', ownBytes: 0 }))).toBe(true);
    expect(diskLabelKey({ id: 'downloads', level: 'ok', ownBytes: 0, sharedWith: 'previews' })).toBe('adminContent.health.disks.shared');
  });

  it('serviceText: reason text with numbers, level text without a reason', () => {
    expect(serviceText({ id: 'media', level: 'err', reason: 'down' })).toBe('Nicht erreichbar');
    expect(serviceText({ id: 'tmdb', level: 'warn', reason: 'invalid_key' })).toBe('Schlüssel ungültig');
    expect(serviceText({ id: 'omdb', level: 'off', reason: 'not_set' })).toBe('Nicht eingerichtet');
    expect(serviceText({ id: 'playbackCheck', level: 'warn', reason: 'failed_titles', detail: { n: 2 } })).toBe('2 Titel fehlgeschlagen');
    expect(serviceText({ id: 'omdb', level: 'warn', reason: 'budget', detail: { n: 820, pct: 91 } })).toBe('Tageslimit zu 91 % genutzt');
    expect(serviceText({ id: 'postgres', level: 'ok' })).toBe('Läuft');
    expect(serviceText({ id: 'playbackCheck', level: 'off' })).toBe('Noch nie gelaufen');
  });

  it('empty media: red pill text, error matching, hint placement', () => {
    expect(serviceText({ id: 'playbackCheck', level: 'err', reason: 'empty_media', detail: { n: 86 } })).toBe('Medienserver liefert leere Videostücke – Jellyfin neu starten; hilft das nicht, Hardware-Beschleunigung prüfen');
    expect(isEmptyMediaError('HTTP 200 empty body')).toBe(true);
    expect(isEmptyMediaError('empty playlist')).toBe(true);
    expect(isEmptyMediaError('empty segment from media server')).toBe(true);
    expect(isEmptyMediaError('HTTP 500 boom')).toBe(false);
    expect(isEmptyMediaError(null)).toBe(false);
    const empty = { ok: false, error: 'HTTP 200 empty body' };
    expect(emptyHintOnTop([empty, empty, { ok: false, error: 'HTTP 500' }])).toBe(true);
    expect(emptyHintOnTop([empty, { ok: true, error: null }])).toBe(false);
    expect(emptyHintOnTop([{ ok: false, error: 'HTTP 500' }])).toBe(false);
    expect(emptyHintOnTop([])).toBe(false);
  });

  it('cleanCode never shows an address or a query', () => {
    expect(cleanCode('resource Failed to load <script> http://jellyfin:8096/x.js?api_key=1')).toBe('resource Failed to load <script> …');
    expect(cleanCode('GET /api/items/:id 500')).toBe('GET /api/items/:id 500');
  });
});
