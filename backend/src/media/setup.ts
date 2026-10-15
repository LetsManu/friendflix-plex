// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { jellyfinSetup } from '../jellyfin/setup.js';
import type { ProbeResult } from '../settings/probeKit.js';
import type { MediaServerKind } from './index.js';

/**
 * How the setup wizard (step 3) and the `media` settings probe talk to a media server kind (spec Part H). The web renders the step from
 * GET /api/setup/state (`media: { keys, auto }`), so a fork adds MEDIA_SETUP.<kind> and its i18n strings and no web code. A kind without
 * an entry falls back to manual fields from mediaSettings(); a provider without `auto` has no "Create API key automatically".
 * Only types come from media/index.ts: index.ts imports this module, so a runtime import back would be a cycle.
 */
export interface MediaSetupProvider {
  kind: MediaServerKind;
  /** registry keys, in field order (Jellyfin: ['JELLYFIN_URL', 'JELLYFIN_ADMIN_API_KEY']) */
  keys: readonly string[];
  /** the gateway upstream (Jellyfin: 'JELLYFIN_URL') */
  urlKey: string;
  /** the settings probe with candidate values; `fetchImpl` never follows a redirect and is aborted at the probe's deadline */
  probe(values: Record<string, string | undefined>, deps: { fetchImpl: typeof fetch }): Promise<ProbeResult>;
  auto?: {
    fields: readonly ('url' | 'username' | 'password')[];
    /** the values to save (keys within `keys`); throws MediaSetupError. The credentials live only in this call: never stored or logged. */
    run(input: { url: string; username: string; password: string }, deps: { fetchImpl: typeof fetch; appVersion: string }): Promise<Record<string, string>>;
    /** best effort: deletes a credential run() created when the save refused it (optional: a provider without it leaves the key); never throws */
    revoke?(values: Record<string, string>, deps: { fetchImpl: typeof fetch }): Promise<void>;
  };
}

export const MEDIA_SETUP: Partial<Record<MediaServerKind, MediaSetupProvider>> = {
  jellyfin: jellyfinSetup,
};
