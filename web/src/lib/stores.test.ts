import { get } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.fn();
vi.mock('#lib/api', () => ({ api: (...a: unknown[]) => api(...a) }));
const { listIds, toggleList, prefs, savePrefs, saveLanguage, loadPrefs, mergePrefsInto, DEFAULT_PREFS } = await import('./stores');
const i18n = await import('#lib/i18n');

beforeEach(() => { api.mockReset(); listIds.set(new Set()); });

describe('toggleList', () => {
  it('adds optimistically and resolves true', async () => {
    api.mockResolvedValue({});
    const p = toggleList('x', false);
    expect(get(listIds).has('x')).toBe(true);
    expect(await p).toBe(true);
    expect(api).toHaveBeenCalledWith('/api/items/x/watchlist', { method: 'POST' });
  });
  it('rolls back and resolves false on failure', async () => {
    api.mockRejectedValue(new Error('x'));
    expect(await toggleList('x', false)).toBe(false);
    expect(get(listIds).has('x')).toBe(false);
  });
  it('ignores a second toggle while the first is in flight', async () => {
    let done!: () => void;
    api.mockImplementation(() => new Promise<void>((r) => (done = r)));
    const a = toggleList('x', false), b = await toggleList('x', true);
    expect(b).toBe(true);
    expect(api).toHaveBeenCalledTimes(1);
    done(); await a;
    expect(get(listIds).has('x')).toBe(true);
  });
});

describe('prefs and the UI language', () => {
  it('savePrefs never sends `language` (its own endpoint; a full PUT must not revert a choice made elsewhere)', async () => {
    api.mockResolvedValue({});
    prefs.set({ ...DEFAULT_PREFS, language: 'fr' });
    await savePrefs({ ...DEFAULT_PREFS, autoplayNext: false, language: 'en' });
    const body = api.mock.calls[0]![1].body as Record<string, unknown>;
    expect(api.mock.calls[0]![0]).toBe('/api/prefs');
    expect('language' in body).toBe(false);
    expect(body.autoplayNext).toBe(false);
    expect(get(prefs)).toMatchObject({ autoplayNext: false, language: 'fr' }); // the store keeps the current language
  });

  it('a /api/prefs answer requested before a language switch does not undo it', async () => {
    let answer!: (v: unknown) => void;
    api.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    prefs.set({ ...DEFAULT_PREFS, language: 'de' });
    const loading = loadPrefs();
    api.mockResolvedValue({});
    await saveLanguage('en');
    answer({ prefs: { ...DEFAULT_PREFS, language: 'de', autoplayNext: false } });
    await loading;
    expect(get(prefs)).toMatchObject({ language: 'en', autoplayNext: false });
    await i18n.setLocale('de');
  });

  it('saveLanguage rebuilds the page once, only when the language really changes', async () => {
    api.mockResolvedValue({});
    await i18n.setLocale('de');
    const e0 = get(i18n.pageEpoch);
    await saveLanguage('de');
    expect(get(i18n.pageEpoch)).toBe(e0);
    await saveLanguage('en');
    expect(get(i18n.pageEpoch)).toBe(e0 + 1);
    await i18n.setLocale('de');
  });

  it('mergePrefsInto keeps unsaved form edits and takes over only fields that changed in the store', () => {
    const prev = { ...DEFAULT_PREFS };
    const form = { ...DEFAULT_PREFS, autoplayNext: false, subtitleStyle: { ...DEFAULT_PREFS.subtitleStyle, size: 'xl' as const } }; // unsaved edits
    const next = { ...DEFAULT_PREFS, language: 'en' as const, subtitleStyle: { ...DEFAULT_PREFS.subtitleStyle, color: 'yellow' as const } };
    const out = mergePrefsInto(form, prev, next);
    expect(out).toMatchObject({ autoplayNext: false, language: 'en', subtitleStyle: { size: 'xl', color: 'yellow' } });
    expect(form.language).toBe(''); // not mutated
    expect(mergePrefsInto(form, null, next)).toEqual(next); // first value: the form starts from the store
  });
});
