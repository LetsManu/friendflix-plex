import { DEFAULT_LOCALE, isLocale, loadLocale, pickLocale, trIn, type Locale } from '#lib/i18n';
import { BRAND_SHORT } from '#lib/brand'; // fork: short home-screen label

/**
 * The web app manifest in the viewer's language (served by routes/manifest.webmanifest/+server.ts; the root layout points
 * `<link rel="manifest">` at `?lang=<ui language>`). Texts come from the i18n dictionaries, nothing is duplicated here.
 */
const BASE = {
  "id": "/",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#141414",
  "theme_color": "#141414",
  "categories": [
    "entertainment"
  ],
  "icons": [
    {
      "src": "/favicon.svg",
      "sizes": "any",
      "type": "image/svg+xml"
    },
    {
      "src": "/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icon-512.png",
      "sizes": "512x512",
      "type": "image/png"
    },
    {
      "src": "/icon-maskable-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ]
} as const;

const icons = [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }];

/** `?lang` (only the 7 supported codes), else the best Accept-Language match (q-weighted), else German. */
export function chooseLang(param: string | null, acceptLanguage: string | null): Locale {
  if (isLocale(param)) return param;
  const ranked = (acceptLanguage ?? '').split(',').map((part, i) => {
    const [tag, ...ps] = part.trim().split(';');
    const q = Number(ps.map((p) => p.trim()).find((p) => p.startsWith('q='))?.slice(2) ?? 1);
    return { tag: (tag ?? '').trim(), q: Number.isFinite(q) ? q : 0, i };
  }).filter((x) => x.tag && x.q > 0).sort((a, b) => b.q - a.q || a.i - b.i);
  return pickLocale(ranked.map((x) => x.tag)) ?? DEFAULT_LOCALE;
}

export async function manifestFor(lang: Locale) {
  await loadLocale(lang);
  const T = (k: Parameters<typeof trIn>[1]) => trIn(lang, k);
  return {
    ...BASE,
    name: T('common.appName'),
    short_name: BRAND_SHORT, // fork: name = common.appName = {brand} (BRAND_NAME), short_name = BRAND_SHORT
    description: T('mine.manifest.description'),
    lang,
    shortcuts: [
      { name: T('home.rows.resume'), short_name: T('home.rows.resume'), description: T('mine.manifest.resumeDesc'), url: '/?shortcut=resume', icons },
      { name: T('shell.nav.myList'), url: '/watchlist', icons },
      { name: T('shell.mobile.search'), url: '/search', icons },
      { name: T('shell.mobile.downloads'), url: '/downloads', icons },
      { name: T('shell.menu.remote'), url: '/remote', icons },
    ],
  };
}
