// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { internalSecret, need, optional } from './env.js';
import { createGateway } from './gateway.js';
import { createRemoteConfig } from './remoteConfig.js';
import { checkUpstreamConfig, selectUpstream } from './upstream/index.js';

const upstream = selectUpstream(process.env.MEDIA_SERVER);
checkUpstreamConfig(upstream, process.env); // like the backend's config validation: refuse to start with a clear error
const backendUrl = need(process.env, 'BACKEND_URL');
const secret = internalSecret(process.env); // env, INTERNAL_SECRET_FILE or the bootstrap-gateway volume
// the media server URL: the adapter's env (JELLYFIN_URL or _FILE) wins and is used as is; otherwise the backend's live settings
const remote = createRemoteConfig({ backendUrl, internalSecret: secret, envUrl: optional(process.env, upstream.urlEnv) });
const { server } = createGateway({
  upstream,
  upstreamUrl: remote.url,
  onConfigRev: remote.noteRev,
  backendUrl,
  internalSecret: secret,
  downloadDir: process.env.DOWNLOAD_DIR || undefined,
  metricsToken: process.env.METRICS_TOKEN || undefined,
});
const port = Number(process.env.PORT ?? 4000);
server.listen(port, '0.0.0.0', () => console.log(`gateway listening on :${port}`));
process.on('SIGTERM', () => {
  remote.stop();
  server.close(() => process.exit(0));
  server.closeIdleConnections(); // keep-alive sockets would otherwise hold close() open
  setTimeout(() => process.exit(0), 8000).unref(); // hard fallback for in-flight streams
});
