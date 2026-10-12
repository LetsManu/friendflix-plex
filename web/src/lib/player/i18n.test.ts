import { afterEach, describe, expect, it } from 'vitest';
import de from '#lib/i18n/locales/de/index';
import en from '#lib/i18n/locales/en/index';
import { hasKey, setLocale, tr } from '#lib/i18n';
import { speedLabel } from './bar';
import { SHORTCUTS } from './keymap';
import { fmtBytes } from '#lib/offline/size';
import { REASON_KEY } from '#lib/offline/license';
import { SUPPORT_HINT } from '#lib/offline/opfs';

const keys = (o: object, p = ''): string[] => Object.entries(o).flatMap(([k, v]) =>
  typeof v === 'string' || (v && typeof v === 'object' && typeof (v as { other?: unknown }).other === 'string') ? [p + k] : keys(v as object, `${p}${k}.`)).sort();

describe('player / account texts', () => {
  afterEach(async () => { await setLocale('de'); });

  it('English covers every key of the player and account areas', () => {
    expect(keys(en.player ?? {})).toEqual(keys(de.player));
    expect(keys(en.account ?? {})).toEqual(keys(de.account));
  });

  it('every shortcut, block reason and support hint has a text', () => {
    for (const s of SHORTCUTS) { expect(hasKey(s.d), s.d).toBe(true); if (s.kKey) expect(hasKey(s.kKey)).toBe(true); }
    for (const k of Object.values(REASON_KEY)) expect(hasKey(k), k).toBe(true);
  });

  it('speed labels, sizes and hints follow the UI language', async () => {
    expect(speedLabel(1)).toBe('1× (Normal)');
    expect(speedLabel(1.25)).toBe('1,25×');
    expect(fmtBytes(4_200_000_000)).toBe('4,2 GB');
    expect(SUPPORT_HINT.tv).toBe('Auf dem Fernseher nicht verfügbar.');
    await setLocale('en');
    expect(speedLabel(1.25)).toBe('1.25×');
    expect(fmtBytes(4_200_000_000)).toBe('4.2 GB');
    expect(SUPPORT_HINT.tv).toBe('Not available on the TV.');
    expect(tr('player.error.maxStreams', { n: 1 })).toBe('At most 1 stream at a time is allowed.');
    expect(tr('account.devices.revoked', { n: 2 })).toBe('2 other sessions ended.');
  });
});
