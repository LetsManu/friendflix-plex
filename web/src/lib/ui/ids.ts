let n = 0;
/** unique DOM id for label/aria wiring (stable per component instance) */
export const uid = (prefix = 'ui'): string => `${prefix}-${++n}`;
