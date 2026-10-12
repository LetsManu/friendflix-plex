import qrcode from 'qrcode-generator';

/** QR code as one SVG path (dark modules as unit squares), rendered by the page itself, so no markup is injected. */
export function qrPath(text: string): { size: number; d: string } {
  const qr = qrcode(0, 'M'); // type 0 = smallest that fits, error correction M
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return { size: n, d };
}
