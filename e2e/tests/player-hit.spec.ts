// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { hitTests } from '../mocks/hit.js';

hitTests([
  { name: 'desktop', size: null },
  { name: 'narrow window', size: { width: 600, height: 800 } },
  { name: 'TV 1080p', size: { width: 1920, height: 1080 }, tv: true },
]);
