import { readFileSync } from 'node:fs';
import { createGateway } from './gateway.js';
import { checkUpstreamConfig, selectUpstream } from './upstream/index.js';

/** Reads VAR or the file referenced by VAR_FILE (Docker secrets). */
const need = (k: string) => {
  const f = process.env[`${k}_FILE`];
  const v = f ? readFileSync(f, 'utf8').trim() : process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const upstream = selectUpstream(process.env.MEDIA_SERVER);
checkUpstreamConfig(upstream, process.env); // like the backend's config validation: refuse to start with a clear error
const { server } = createGateway({
  upstream,
  upstreamUrl: need(upstream.urlEnv),
  backendUrl: need('BACKEND_URL'),
  internalSecret: need('INTERNAL_SECRET'),
  downloadDir: process.env.DOWNLOAD_DIR || undefined,
  metricsToken: process.env.METRICS_TOKEN || undefined,
});
const port = Number(process.env.PORT ?? 4000);
server.listen(port, '0.0.0.0', () => console.log(`gateway listening on :${port}`));
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  server.closeIdleConnections(); // keep-alive sockets would otherwise hold close() open
  setTimeout(() => process.exit(0), 8000).unref(); // hard fallback for in-flight streams
});
