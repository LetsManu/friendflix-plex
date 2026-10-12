import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';
import { localeManifest } from './src/service-worker/precache.ts';

/** Writes /_app/locales.json (language → its chunk files) for the service worker's offline language precache. */
const localeChunks = (): Plugin => ({
  name: 'ff-locale-manifest',
  apply: 'build',
  generateBundle(_opts, bundle) {
    const m = localeManifest(bundle as unknown as Parameters<typeof localeManifest>[0]);
    if (m) this.emitFile({ type: 'asset', fileName: '_app/locales.json', source: JSON.stringify(m) });
  },
});

export default defineConfig({
  plugins: [
    localeChunks(),
    sveltekit({
      preprocess: vitePreprocess(),
      adapter: adapter(),
      // Strict CSP: only own origin. hls.js needs blob: for its worker and media source; styles are inline from Svelte.
      csp: {
        mode: 'auto',
        directives: {
          'default-src': ['self'],
          // gstatic: Google Cast sender SDK (loaded lazily by lib/cast.ts, only on Chromium when casting is enabled), path-scoped.
          // TODO verify on hardware (Chrome + Chromecast): if the SDK loads further scripts from other gstatic paths, add only those paths.
          'script-src': ['self', 'https://www.gstatic.com/cv/js/sender/', 'https://www.gstatic.com/cast/sdk/libs/'],
          'style-src': ['self', 'unsafe-inline'],
          'font-src': ['self', 'data:'],
          'img-src': ['self', 'data:', 'blob:'],
          'media-src': ['self', 'blob:'],
          'connect-src': ['self', 'ws:', 'wss:'],
          'frame-src': ['https://www.youtube-nocookie.com'],
          'worker-src': ['self', 'blob:'],
          'object-src': ['none'],
          'base-uri': ['self'],
          'frame-ancestors': ['none'],
          'form-action': ['self'],
        },
      },
    }),
  ],
  // Dev: the browser talks to one origin; proxy API, auth, media and websockets to the backend/gateway.
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
      '/media': 'http://localhost:4000',
    },
  },
});
