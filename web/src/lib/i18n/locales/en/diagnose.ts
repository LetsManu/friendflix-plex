import type de from '../de/diagnose';
import type { Translation } from '../../types';

const dict: Translation<typeof de> = {
  title: 'Display diagnostics',
  hint: 'Measurements of this device\'s viewport (window, safe areas, tab bar). Take a screenshot or copy the values.',
  copy: 'Copy values',
  copied: 'Copied.',
  copyFailed: 'Copying failed, please select the text.',
};
export default dict;
