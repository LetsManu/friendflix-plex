// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { hitTests } from '../mocks/hit.js';

hitTests([
  { name: 'portrait phone', size: null },
  { name: 'landscape phone', size: { width: 852, height: 393 } },
  { name: 'portrait phone, notch and home indicator', size: { width: 393, height: 852 }, safe: { top: 59, right: 0, bottom: 34, left: 0 } },
  { name: 'landscape phone, notch on the sides', size: { width: 852, height: 393 }, safe: { top: 0, right: 59, bottom: 21, left: 59 } },
]);
