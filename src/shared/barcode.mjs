// Shared barcode geometry/format. The same module is used by the frame
// renderer, the tests that decode decoded video, and the browser player.
//
// 32 blocks, left to right = bits 0..31 of a little-endian word:
//   bits  0.. 3  epoch ordinal (0..15)
//   bits  4..23  frame number (0..1048575)
//   bits 24..27  reserved (always 0)
//   bits 28..31  checksum = XOR of the six 4-bit nibbles of bits 0..23
// White block = 1, black block = 0.

export const BARCODE = Object.freeze({
  x: 32,
  y: 16,
  block: 16,
  gap: 2,
  bits: 32,
  panelPadding: 8,
});

export const FRAME_WIDTH = 640;
export const FRAME_HEIGHT = 360;

export function checksumNibble(word24) {
  let c = 0;
  for (let i = 0; i < 6; i++) c ^= (word24 >>> (i * 4)) & 0xf;
  return c & 0xf;
}

export function encodeBarcodeWord(epoch, frame) {
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > 15) throw new Error('epoch out of range');
  if (!Number.isInteger(frame) || frame < 0 || frame > 0xfffff) throw new Error('frame out of range');
  const data = (epoch & 0xf) | ((frame & 0xfffff) << 4);
  const word = data | (checksumNibble(data) << 28);
  const bits = new Array(32);
  for (let i = 0; i < 32; i++) bits[i] = (word >>> i) & 1;
  return { word, bits };
}

export function decodeBarcodeWord(word) {
  const epoch = word & 0xf;
  const frame = (word >>> 4) & 0xfffff;
  const reserved = (word >>> 24) & 0xf;
  const checksum = (word >>> 28) & 0xf;
  const expected = checksumNibble(word & 0xffffff);
  return {
    epoch,
    frame,
    reserved,
    checksum,
    checksumOk: checksum === expected,
  };
}

export function barcodeBitRect(i) {
  const stride = BARCODE.block + BARCODE.gap;
  return {
    x: BARCODE.x + i * stride,
    y: BARCODE.y,
    w: BARCODE.block,
    h: BARCODE.block,
  };
}

export function barcodePanelRect() {
  const stride = BARCODE.block + BARCODE.gap;
  const width = BARCODE.bits * stride - BARCODE.gap;
  return {
    x: BARCODE.x - BARCODE.panelPadding,
    y: BARCODE.y - BARCODE.panelPadding,
    w: width + BARCODE.panelPadding * 2,
    h: BARCODE.block + BARCODE.panelPadding * 2,
  };
}

// RGB24 buffer, row-major, top-left origin. Samples the middle of every
// block, which tolerates lossy H.264 compression.
export function decodeBarcodeFromRGB(buf, width = FRAME_WIDTH, height = FRAME_HEIGHT) {
  if (buf.length < width * height * 3) throw new Error('frame buffer too small');
  let word = 0;
  for (let i = 0; i < BARCODE.bits; i++) {
    const r = barcodeBitRect(i);
    const cx = r.x + Math.floor(r.w / 2);
    const cy = r.y + Math.floor(r.h / 2);
    if (cx >= width || cy >= height) throw new Error('barcode outside frame');
    const off = (cy * width + cx) * 3;
    const lum = 0.2126 * buf[off] + 0.7152 * buf[off + 1] + 0.0722 * buf[off + 2];
    if (lum > 128) word |= 1 << i;
  }
  return decodeBarcodeWord(word >>> 0);
}

// RGBA (canvas ImageData) variant.
export function decodeBarcodeFromRGBA(buf, width = FRAME_WIDTH, height = FRAME_HEIGHT) {
  if (buf.length < width * height * 4) throw new Error('frame buffer too small');
  let word = 0;
  for (let i = 0; i < BARCODE.bits; i++) {
    const r = barcodeBitRect(i);
    const cx = r.x + Math.floor(r.w / 2);
    const cy = r.y + Math.floor(r.h / 2);
    const off = (cy * width + cx) * 4;
    const lum = 0.2126 * buf[off] + 0.7152 * buf[off + 1] + 0.0722 * buf[off + 2];
    if (lum > 128) word |= 1 << i;
  }
  return decodeBarcodeWord(word >>> 0);
}
