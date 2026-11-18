// Frame barcode: 32-bit capture frame id + CRC8 over the id bytes, drawn as
// high-contrast modules in a bottom band. Decoders can read it back from the
// encoded picture, which makes frame identity verifiable end to end.

export const BARCODE = {
  width: 640,
  height: 360,
  modules: 40, // 32 id bits + 8 checksum bits
  moduleWidth: 14,
  x0: 20,
  y0: 300,
  bandHeight: 40,
  barTop: 304,
  barHeight: 32,
  sampleY: 320,
};

const CRC_TABLE = (() => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? (0x07 ^ (c << 1)) & 0xff : (c << 1) & 0xff;
    table[i] = c;
  }
  return table;
})();

export function crc8(bytes) {
  let c = 0;
  for (const b of bytes) c = CRC_TABLE[c ^ b];
  return c;
}

export function encodeBarcodeBits(frameId) {
  if (!Number.isInteger(frameId) || frameId < 0 || frameId > 0xffffffff) {
    throw new RangeError(`frame id out of range: ${frameId}`);
  }
  const idBytes = [
    (frameId >>> 24) & 0xff,
    (frameId >>> 16) & 0xff,
    (frameId >>> 8) & 0xff,
    frameId & 0xff,
  ];
  const checksum = crc8(idBytes);
  const bits = [];
  for (const b of idBytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  for (let i = 7; i >= 0; i--) bits.push((checksum >> i) & 1);
  return bits;
}

// Decode from a Uint8Array/array of RGB or RGBA pixels. `stride` is bytes per row.
export function decodeBarcodeFromPixels(pixels, width, stride, channels, height) {
  if (width !== BARCODE.width || height !== BARCODE.height) {
    throw new Error(`unexpected frame size ${width}x${height}`);
  }
  const bits = [];
  for (let m = 0; m < BARCODE.modules; m++) {
    const x = BARCODE.x0 + m * BARCODE.moduleWidth + Math.floor(BARCODE.moduleWidth / 2);
    const votes = [BARCODE.sampleY - 6, BARCODE.sampleY, BARCODE.sampleY + 6];
    let dark = 0;
    for (const y of votes) {
      const o = y * stride + x * channels;
      const lum = 0.299 * pixels[o] + 0.587 * pixels[o + 1] + 0.114 * pixels[o + 2];
      if (lum < 128) dark++;
    }
    bits.push(dark >= 2 ? 1 : 0);
  }
  let id = 0;
  const idBytes = [];
  for (let i = 0; i < 32; i++) id = id * 2 + bits[i];
  for (let i = 0; i < 4; i++) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = b * 2 + bits[i * 8 + k];
    idBytes.push(b);
  }
  let sum = 0;
  for (let i = 0; i < 8; i++) sum = sum * 2 + bits[32 + i];
  const expected = crc8(idBytes);
  return { frameId: id >>> 0, checksum: sum, checksumOk: sum === expected };
}

export function decodeBarcodeFromImageData(data, width, height) {
  return decodeBarcodeFromPixels(data, width, width * 4, 4, height);
}

export function drawBarcode(rgb, width, frameId) {
  const bits = encodeBarcodeBits(frameId);
  const { x0, y0, bandHeight, barTop, barHeight, moduleWidth, modules } = BARCODE;
  const bandLeft = x0 - 6;
  const bandRight = x0 + modules * moduleWidth + 6;
  for (let y = y0; y < y0 + bandHeight; y++) {
    for (let x = bandLeft; x < bandRight; x++) {
      const o = (y * width + x) * 3;
      rgb[o] = 235;
      rgb[o + 1] = 235;
      rgb[o + 2] = 235;
    }
  }
  for (let m = 0; m < modules; m++) {
    const start = x0 + m * moduleWidth;
    const value = bits[m] ? 14 : 245;
    for (let y = barTop; y < barTop + barHeight; y++) {
      for (let x = start; x < start + moduleWidth; x++) {
        const o = (y * width + x) * 3;
        rgb[o] = value;
        rgb[o + 1] = value;
        rgb[o + 2] = value;
      }
    }
  }
}
