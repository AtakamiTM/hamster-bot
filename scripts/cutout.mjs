// Removes the white background from the banners in img/ (originals are kept in img/_original).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const dir = path.resolve(import.meta.dirname, '..', 'img');
const backup = path.join(dir, '_original');
fs.mkdirSync(backup, { recursive: true });

const WHITE = 238; // every channel >= this counts as "background white"
const SOFT = 205;  // lower bound for anti-aliased edge pixels

async function cutout(file) {
  const src = path.join(backup, file);
  if (!fs.existsSync(src)) fs.copyFileSync(path.join(dir, file), src);

  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const px = (n) => n * 4;
  const isWhite = (n) => data[px(n)] >= WHITE && data[px(n) + 1] >= WHITE && data[px(n) + 2] >= WHITE;

  // Flood fill from the border: only white connected to the outside is background.
  const bg = new Uint8Array(w * h);
  const stack = [];
  const push = (n) => { if (!bg[n] && isWhite(n)) { bg[n] = 1; stack.push(n); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const n = stack.pop();
    const x = n % w;
    if (x > 0) push(n - 1);
    if (x < w - 1) push(n + 1);
    if (n >= w) push(n - w);
    if (n < w * (h - 1)) push(n + w);
  }

  // Distance (in px) to the background, up to 3, to find the anti-aliased fringe.
  const near = new Uint8Array(w * h);
  let frontier = [];
  for (let n = 0; n < w * h; n++) if (bg[n]) frontier.push(n);
  for (let d = 1; d <= 3; d++) {
    const next = [];
    for (const n of frontier) {
      const x = n % w;
      for (const m of [x > 0 ? n - 1 : -1, x < w - 1 ? n + 1 : -1, n >= w ? n - w : -1, n < w * (h - 1) ? n + w : -1]) {
        if (m >= 0 && !bg[m] && !near[m]) { near[m] = d; next.push(m); }
      }
    }
    frontier = next;
  }

  for (let n = 0; n < w * h; n++) {
    const i = px(n);
    if (bg[n]) { data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0; continue; }
    if (!near[n]) continue;
    const lo = Math.min(data[i], data[i + 1], data[i + 2]);
    if (lo <= SOFT) continue;
    // Fringe pixel that is still mostly white: fade it out and remove the white matte.
    const a = Math.max(0, Math.min(1, 1 - (lo - SOFT) / (255 - SOFT)));
    if (a < 0.04) { data[i + 3] = 0; continue; }
    for (let c = 0; c < 3; c++) data[i + c] = Math.max(0, Math.min(255, Math.round((data[i + c] - 255 * (1 - a)) / a)));
    data[i + 3] = Math.round(a * 255);
  }

  await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png({ compressionLevel: 9 }).toFile(path.join(dir, file));
  const cleared = bg.reduce((s, v) => s + v, 0);
  console.log(`${file}: ${(cleared / (w * h) * 100).toFixed(1)}% transparent`);
}

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.png'))) await cutout(file);
