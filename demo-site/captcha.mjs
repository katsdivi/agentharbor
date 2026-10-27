/**
 * Self-drawn CAPTCHAs, rendered to PNG with no dependencies.
 *
 * The answer exists only in pixels: the HTML carries an opaque image URL, never the
 * text, the shape names or any SVG/path data an agent could parse instead of looking.
 *
 *   text  - 6 warped, rotated, sheared stroke characters over noise and decoy lines
 *   grid  - 3x3 tiles; "select every tile with a <shape>" (2-4 correct tiles)
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const rnd = (a, b) => a + Math.random() * (b - a);
const rint = (a, b) => Math.floor(rnd(a, b + 1));
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

// ---------------------------------------------------------------- raster + PNG

class Canvas {
  constructor(w, h, bg) {
    this.w = w;
    this.h = h;
    this.px = Buffer.alloc(w * h * 3);
    for (let i = 0; i < w * h; i++) this.px.set(bg, i * 3);
  }
  set(x, y, c) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.px.set(c, (y * this.w + x) * 3);
  }
  disc(cx, cy, r, c) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) this.set(x, y, c);
  }
  line(x0, y0, x1, y1, thick, c) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let i = 0; i <= n; i++) this.disc(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, thick / 2, c);
  }
  /** Scanline even-odd polygon fill. */
  polygon(pts, c) {
    const ys = pts.map((p) => p[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) for (let x = Math.ceil(xs[i]); x <= xs[i + 1]; x++) this.set(x, y, c);
    }
  }
  png() {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 3 + 1)] = 0;
      this.px.copy(raw, y * (this.w * 3 + 1) + 1, y * this.w * 3, (y + 1) * this.w * 3);
    }
    const chunk = (type, data) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(zlib.crc32(td));
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  }
}

const darkColor = () => [rint(10, 110), rint(10, 110), rint(10, 110)];
const lightColor = () => [rint(200, 250), rint(200, 250), rint(200, 250)];

// ---------------------------------------------------------------- text CAPTCHA

/** Stroke font on a 4x6 grid. Ambiguous glyphs (0/O, 1/I, 2/Z, 5/S, 8/B, 6/G) are left out. */
const GLYPHS = {
  A: [[[0, 6], [2, 0], [4, 6]], [[1, 3], [3, 3]]],
  C: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5]]],
  D: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 1], [3, 0], [0, 0]]],
  E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]],
  F: [[[4, 0], [0, 0], [0, 6]], [[0, 3], [3, 3]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  J: [[[4, 0], [4, 5], [3, 6], [1, 6], [0, 5]]],
  K: [[[0, 0], [0, 6]], [[4, 0], [0, 3.5]], [[1.2, 2.8], [4, 6]]],
  L: [[[0, 0], [0, 6], [4, 6]]],
  M: [[[0, 6], [0, 0], [2, 3], [4, 0], [4, 6]]],
  N: [[[0, 6], [0, 0], [4, 6], [4, 0]]],
  P: [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]]],
  R: [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]], [[2, 3], [4, 6]]],
  T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
  U: [[[0, 0], [0, 5], [1, 6], [3, 6], [4, 5], [4, 0]]],
  V: [[[0, 0], [2, 6], [4, 0]]],
  W: [[[0, 0], [1, 6], [2, 2], [3, 6], [4, 0]]],
  X: [[[0, 0], [4, 6]], [[4, 0], [0, 6]]],
  Y: [[[0, 0], [2, 3], [4, 0]], [[2, 3], [2, 6]]],
  3: [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [1.5, 3]], [[3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
  4: [[[3, 6], [3, 0], [0, 4], [4, 4]]],
  7: [[[0, 0], [4, 0], [1.5, 6]]],
  9: [[[4, 3], [1, 3], [0, 2], [0, 1], [1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5]]],
};
const CHARSET = Object.keys(GLYPHS);

export function textCaptcha(len = 6) {
  const W = 260;
  const H = 80;
  const text = Array.from({ length: len }, () => pick(CHARSET)).join('');
  const cv = new Canvas(W, H, lightColor());
  for (let i = 0; i < 900; i++) cv.set(rnd(0, W), rnd(0, H), pick([lightColor(), darkColor()]));
  // Whole-image wave applied to every glyph point.
  const ax = rnd(2, 5), fx = rnd(0.05, 0.12), ay = rnd(2, 5), fy = rnd(0.03, 0.07), ph = rnd(0, 6);
  const warp = (x, y) => [x + ax * Math.sin(y * fx + ph), y + ay * Math.sin(x * fy + ph)];
  const step = (W - 30) / len;
  [...text].forEach((ch, i) => {
    const s = rnd(5.5, 7.5), th = rnd(-0.45, 0.45), sh = rnd(-0.3, 0.3);
    const cx = 15 + step * (i + 0.5) + rnd(-4, 4), cy = H / 2 + rnd(-6, 6);
    const color = darkColor();
    const tf = ([gx, gy]) => {
      let x = (gx - 2) * s, y = (gy - 3) * s;
      x += sh * y;
      return warp(cx + x * Math.cos(th) - y * Math.sin(th), cy + x * Math.sin(th) + y * Math.cos(th));
    };
    for (const stroke of GLYPHS[ch]) {
      for (let k = 0; k + 1 < stroke.length; k++) {
        const [a, b] = [stroke[k], stroke[k + 1]];
        const n = 8; // subdivide so the wave bends straight strokes
        for (let j = 0; j < n; j++) {
          const p = tf([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
          const q = tf([a[0] + ((b[0] - a[0]) * (j + 1)) / n, a[1] + ((b[1] - a[1]) * (j + 1)) / n]);
          cv.line(p[0], p[1], q[0], q[1], 3.2, color);
        }
      }
    }
  });
  // Decoy strokes crossing the text.
  for (let l = 0; l < 4; l++) {
    const y0 = rnd(10, H - 10), amp = rnd(5, 18), f = rnd(0.02, 0.06), p = rnd(0, 6), c = darkColor();
    let prev = [0, y0];
    for (let x = 4; x <= W; x += 4) {
      const cur = [x, y0 + amp * Math.sin(x * f + p)];
      cv.line(prev[0], prev[1], cur[0], cur[1], 1.6, c);
      prev = cur;
    }
  }
  return { answer: text, png: cv.png() };
}

// ---------------------------------------------------------------- grid CAPTCHA

const SHAPES = ['triangle', 'circle', 'square', 'pentagon'];

function regular(cx, cy, r, n, rot) {
  return Array.from({ length: n }, (_, i) => [cx + r * Math.cos(rot + (2 * Math.PI * i) / n), cy + r * Math.sin(rot + (2 * Math.PI * i) / n)]);
}

function tile(shape) {
  const S = 96;
  const cv = new Canvas(S, S, lightColor());
  for (let i = 0; i < 6; i++) cv.line(rnd(0, S), rnd(0, S), rnd(0, S), rnd(0, S), rnd(1, 2.5), [rint(150, 210), rint(150, 210), rint(150, 210)]);
  for (let i = 0; i < 250; i++) cv.set(rnd(0, S), rnd(0, S), darkColor());
  const cx = rnd(38, 58), cy = rnd(38, 58), r = rnd(22, 32), rot = rnd(0, 2 * Math.PI), c = darkColor();
  if (shape === 'circle') cv.disc(cx, cy, r * 0.85, c);
  else cv.polygon(regular(cx, cy, r, { triangle: 3, square: 4, pentagon: 5 }[shape], rot), c);
  return cv.png();
}

export function gridCaptcha() {
  const target = pick(SHAPES);
  const nTarget = rint(2, 4);
  const shapes = [...Array(nTarget).fill(target), ...Array.from({ length: 9 - nTarget }, () => pick(SHAPES.filter((s) => s !== target)))];
  for (let i = shapes.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shapes[i], shapes[j]] = [shapes[j], shapes[i]];
  }
  return {
    target,
    answer: shapes.map((s, i) => (s === target ? i : -1)).filter((i) => i >= 0),
    tiles: shapes.map(tile),
  };
}

// ---------------------------------------------------------------- challenge store

const TTL_MS = 5 * 60 * 1000;
const challenges = new Map();

/** One challenge = one text CAPTCHA + one grid CAPTCHA, single-use, 5 minute expiry. */
export function issueChallenge() {
  for (const [id, c] of challenges) if (Date.now() - c.created > TTL_MS) challenges.delete(id);
  const id = crypto.randomBytes(16).toString('hex');
  const text = textCaptcha();
  const grid = gridCaptcha();
  challenges.set(id, { created: Date.now(), text, grid });
  return { id, target: grid.target };
}

export function challengeImage(id, which) {
  const c = challenges.get(id);
  if (!c) return null;
  if (which === 'text') return c.text.png;
  const i = Number(which);
  return Number.isInteger(i) && i >= 0 && i < 9 ? c.grid.tiles[i] : null;
}

/** Checks and consumes the challenge. Returns { textOk, gridOk, expired }. */
export function checkChallenge(id, textAnswer, tiles) {
  const c = challenges.get(id);
  challenges.delete(id);
  if (!c || Date.now() - c.created > TTL_MS) return { textOk: false, gridOk: false, expired: true };
  const textOk = String(textAnswer || '').replace(/\s+/g, '').toUpperCase() === c.text.answer;
  const chosen = [...new Set(tiles.map(Number))].sort((a, b) => a - b);
  const gridOk = chosen.length === c.grid.answer.length && chosen.every((v, i) => v === c.grid.answer[i]);
  return { textOk, gridOk, expired: false };
}
