// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import type de from '../de/diagnose';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  title: 'Display diagnostics',
  hint: 'Measurements of this device\'s viewport (window, safe areas, tab bar). Take a screenshot or copy the values.',
  copy: 'Copy values',
  copied: 'Copied.',
  copyFailed: 'Copying failed, please select the text.',
  airplayTitle: 'AirPlay log',
  airplayHint: 'The latest AirPlay events on this device (no addresses or tokens). Copy and send it along when reporting a problem.',
  airplayCopy: 'Copy',
  airplayClear: 'Clear',
  airplayEmpty: 'No entries yet.',
  timingTitle: 'Start times',
  timingHint: 'The latest playbacks on this device: how long info, playlist, first segment and first frame took, plus seeks and stalls.',
  timingEmpty: 'No measurements on this device yet.',
};
export default dict;
