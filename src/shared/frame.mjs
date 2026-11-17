// Deterministic RGB24 frame renderer. No font or drawtext filter needed: the
// frame number is drawn both as a machine-readable barcode and as large
// seven-segment digits, so a decoded video frame can be checked against the
// kernel's media time exactly.

export const FRAME_WIDTH = 480;
export const FRAME_HEIGHT = 270;
export const FPS = 30;

export const BARCODE = Object.freeze({
  x: 16,
  y: 12,
  block: 12,
  gap: 2,
  bits: 32,
  panelPadding: 6,
});

export const FRAME = Object.freeze({
  width: FRAME_WIDTH,
  height: FRAME_HEIGHT,
  fps: FPS,
});

export function checksumNibble(word24) {
  let c = 0;
  for (let i = 0; i < 6; i += 1) c ^= (word24 >>> (i * 4)) & 0xf;
  return c & 0xf;
}

export function encodeBarcodeWord(epoch, frame) {
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > 15) throw new Error('epoch out of range');
  if (!Number.isInteger(frame) || frame < 0 || frame > 0xfffff) throw new Error('frame out of range');
  const data = (epoch & 0xf) | ((frame & 0xfffff) << 4);
  const word = (data | (checksumNibble(data) << 28)) >>> 0;
  const bits = new Array(32);
  for (let i = 0; i < 32; i += 1) bits[i] = (word >>> i) & 1;
  return { word, bits };
}

export function decodeBarcodeWord(word) {
  const word32 = word >>> 0;
  const epoch = word32 & 0xf;
  const frame = (word32 >>> 4) & 0xfffff;
  const reserved = (word32 >>> 24) & 0xf;
  const checksum = (word32 >>> 28) & 0xf;
  return {
    epoch,
    frame,
    reserved,
    checksum,
    checksumOk: checksum === checksumNibble(word32 & 0xffffff),
  };
}

export function barcodeBitRect(i) {
  const stride = BARCODE.block + BARCODE.gap;
  return { x: BARCODE.x + i * stride, y: BARCODE.y, w: BARCODE.block, h: BARCODE.block };
}

export function barcodePanelRect() {
  const stride = BARCODE.block + BARCODE.gap;
  return {
    x: BARCODE.x - BARCODE.panelPadding,
    y: BARCODE.y - BARCODE.panelPadding,
    w: BARCODE.bits * stride - BARCODE.gap + BARCODE.panelPadding * 2,
    h: BARCODE.block + BARCODE.panelPadding * 2,
  };
}

function decodeWordFromSampler(width, height, sample) {
  let word = 0;
  for (let i = 0; i < BARCODE.bits; i += 1) {
    const r = barcodeBitRect(i);
    const cx = r.x + Math.floor(r.w / 2);
    const cy = r.y + Math.floor(r.h / 2);
    if (cx >= width || cy >= height) throw new Error('barcode outside frame');
    if (sample(cx, cy)) word |= 1 << i;
  }
  return decodeBarcodeWord(word);
}

export function decodeBarcodeFromRGB(buf, width = FRAME_WIDTH, height = FRAME_HEIGHT) {
  if (buf.length < width * height * 3) throw new Error('frame buffer too small');
  return decodeWordFromSampler(width, height, (x, y) => {
    const off = (y * width + x) * 3;
    return 0.2126 * buf[off] + 0.7152 * buf[off + 1] + 0.0722 * buf[off + 2] > 128;
  });
}

export function decodeBarcodeFromRGBA(buf, width = FRAME_WIDTH, height = FRAME_HEIGHT) {
  if (buf.length < width * height * 4) throw new Error('frame buffer too small');
  return decodeWordFromSampler(width, height, (x, y) => {
    const off = (y * width + x) * 4;
    return 0.2126 * buf[off] + 0.7152 * buf[off + 1] + 0.0722 * buf[off + 2] > 128;
  });
}

// ---- seven-segment digits -------------------------------------------------

const SEGMENTS = {
  0: 'abcedf',
  1: 'bc',
  2: 'abged',
  3: 'abgcd',
  4: 'fgbc',
  5: 'afgcd',
  6: 'afgecd',
  7: 'abc',
  8: 'abcdefg',
  9: 'abfgcd',
};

function hexToRGB(hex) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 3);
  }

  fill(rgb) {
    const [r, g, b] = rgb;
    for (let i = 0; i < this.data.length; i += 3) {
      this.data[i] = r;
      this.data[i + 1] = g;
      this.data[i + 2] = b;
    }
  }

  rect(x, y, w, h, rgb) {
    const [r, g, b] = rgb;
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let yy = y0; yy < y1; yy += 1) {
      let off = (yy * this.width + x0) * 3;
      for (let xx = x0; xx < x1; xx += 1) {
        this.data[off] = r;
        this.data[off + 1] = g;
        this.data[off + 2] = b;
        off += 3;
      }
    }
  }

  digit(x, y, w, h, thickness, digit, rgb) {
    const segs = SEGMENTS[digit] ?? '';
    const has = (s) => segs.includes(s);
    const t = thickness;
    if (has('a')) this.rect(x + t, y, w - 2 * t, t, rgb);
    if (has('b')) this.rect(x + w - t, y + t, t, h / 2 - t, rgb);
    if (has('c')) this.rect(x + w - t, y + h / 2, t, h / 2 - t, rgb);
    if (has('d')) this.rect(x + t, y + h - t, w - 2 * t, t, rgb);
    if (has('e')) this.rect(x, y + h / 2, t, h / 2 - t, rgb);
    if (has('f')) this.rect(x, y + t, t, h / 2 - t, rgb);
    if (has('g')) this.rect(x + t, y + h / 2 - t / 2, w - 2 * t, t, rgb);
  }

  number(x, y, digits, { digitWidth = 26, digitHeight = 44, gap = 8, thickness = 5, rgb = [255, 255, 255] } = {}) {
    let cursor = x;
    for (const ch of String(digits)) {
      this.digit(cursor, y, digitWidth, digitHeight, thickness, ch, rgb);
      cursor += digitWidth + gap;
    }
    return cursor;
  }
}

const BACKGROUND = [10, 16, 26];
const EPOCH_COLORS = [
  0xff8a00, 0x3ddc97, 0x4aa8ff, 0xff5d8f, 0xf5d90a, 0x9b7bff, 0x00d4d4, 0xff6b3d,
  0x8be04e, 0xd4a5ff, 0x5ce1e6, 0xffc44a, 0x5dff9b, 0xff9ad5, 0x7f9cff, 0xe0e0e0,
];

// Renders one frame. `epoch` is the discontinuity/relation epoch, `frame` the
// absolute frame index within that epoch. `hint` labels the source time the
// frame belongs to (for humans; the barcode is the authority).
export function renderFrameBuffer({ epoch, frame, declaredMs = null, mediaMs = null, gap = false }) {
  const canvas = new Canvas(FRAME_WIDTH, FRAME_HEIGHT);
  canvas.fill(gap ? [40, 8, 8] : BACKGROUND);

  const accent = EPOCH_COLORS[epoch % EPOCH_COLORS.length];
  const accentRGB = hexToRGB(accent);

  // Epoch stripe and moving marker.
  canvas.rect(0, 0, FRAME_WIDTH, 4, accentRGB);
  const barWidth = 34;
  const barX = (frame * 3) % Math.max(1, FRAME_WIDTH - barWidth);
  canvas.rect(barX, FRAME_HEIGHT - 26, barWidth, 26, accentRGB);

  // Barcode panel.
  const panel = barcodePanelRect();
  canvas.rect(panel.x, panel.y, panel.w, panel.h, [24, 30, 42]);
  const { bits, word } = encodeBarcodeWord(epoch, frame & 0xfffff);
  for (let i = 0; i < bits.length; i += 1) {
    const r = barcodeBitRect(i);
    canvas.rect(r.x, r.y, r.w, r.h, bits[i] ? [255, 255, 255] : [0, 0, 0]);
  }

  // Human-readable epoch / frame / times.
  const digits = String(frame).padStart(7, '0');
  canvas.number(panel.x, 58, digits, { digitWidth: 26, digitHeight: 46, gap: 7, thickness: 5 });
  canvas.number(panel.x + panel.w - 40, 58, String(epoch), {
    digitWidth: 26,
    digitHeight: 46,
    gap: 7,
    thickness: 5,
    rgb: accentRGB,
  });

  // Media-time ruler: one tick per second, filled up to this frame's time.
  const rulerY = 140;
  canvas.rect(16, rulerY, FRAME_WIDTH - 32, 3, [60, 70, 90]);
  const seconds = Math.floor(frame / FPS);
  const fillW = Math.min(FRAME_WIDTH - 32, seconds * 12);
  canvas.rect(16, rulerY, fillW, 3, accentRGB);
  for (let s = 0; s <= 30; s += 1) {
    const x = 16 + s * 12;
    if (x > FRAME_WIDTH - 32) break;
    canvas.rect(x, rulerY - 4, 1, 11, [90, 100, 120]);
  }

  // A distinct per-frame block that makes dropped/skipped frames obvious.
  const cx = 24 + ((frame * 37) % (FRAME_WIDTH - 48));
  const cy = 170 + ((frame * 17) % 70);
  canvas.rect(cx, cy, 18, 18, [250, 250, 250]);
  canvas.rect(cx + 5, cy + 5, 8, 8, accentRGB);

  return { buffer: canvas.data, word };
}

// Barcode-only rendering used by tests that do not need the full frame.
export function renderBarcodeOnly(epoch, frame, width = FRAME_WIDTH, height = FRAME_HEIGHT) {
  return renderFrameBuffer({ epoch, frame }).buffer;
}
