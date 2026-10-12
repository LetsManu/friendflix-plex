/** Average "mood" colour of an image (small canvas sample, saturation-weighted). Same-origin images only. */
export function dominantColor(src: string): Promise<[number, number, number] | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const g = c.getContext('2d', { willReadFrequently: true });
        if (!g) return resolve(null);
        g.drawImage(img, 0, 0, 24, 24);
        const d = g.getImageData(0, 0, 24, 24).data;
        let r = 0, gg = 0, b = 0, w = 0;
        for (let i = 0; i < d.length; i += 4) {
          const mx = Math.max(d[i]!, d[i + 1]!, d[i + 2]!), mn = Math.min(d[i]!, d[i + 1]!, d[i + 2]!);
          const wt = 0.15 + (mx - mn) / 255 + (mx > 40 && mx < 235 ? 0.4 : 0); // prefer colourful, not-black/not-white pixels
          r += d[i]! * wt; gg += d[i + 1]! * wt; b += d[i + 2]! * wt; w += wt;
        }
        resolve(w ? [Math.round(r / w), Math.round(gg / w), Math.round(b / w)] : null);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
