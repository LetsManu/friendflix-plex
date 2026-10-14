// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { version } from '$app/env';
import type { HandleClientError } from '@sveltejs/kit/hooks';
import { installTelemetry, reportError } from '#lib/telemetry';

installTelemetry({ release: version });

export const handleError: HandleClientError = ({ error }) => {
  // providing handleError replaces SvelteKit's default console output; returning nothing keeps its default error page / message
  console.error(error);
  reportError(error);
};
