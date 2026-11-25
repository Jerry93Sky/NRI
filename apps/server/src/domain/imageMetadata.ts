import sharp from 'sharp';

export type ImageMetadata = { mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number };

const MAX_AXIS = 8192;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function byteAt(buffer: Buffer, offset: number): number {
  const value = buffer[offset];
  if (value === undefined) throw new Error('INVALID_IMAGE');
  return value;
}

function checked(mediaType: ImageMetadata['mediaType'], width: number, height: number): ImageMetadata {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_AXIS || height > MAX_AXIS || width * height * 4 > MAX_DECODED_BYTES) {
    throw new Error('IMAGE_DIMENSIONS_UNSUPPORTED');
  }
  return { mediaType, width, height };
}

export function inspectImage(buffer: Buffer): ImageMetadata {
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(pngSignature)) {
    if (buffer.readUInt32BE(8) < 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('INVALID_IMAGE');
    return checked('image/png', buffer.readUInt32BE(16), buffer.readUInt32BE(20));
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) throw new Error('INVALID_IMAGE');
      while (offset < buffer.length && buffer[offset] === 0xff) offset++;
      if (offset >= buffer.length) break;
      const marker = byteAt(buffer, offset++);
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) throw new Error('INVALID_IMAGE');
      if (SOF_MARKERS.has(marker)) {
        if (length < 7) throw new Error('INVALID_IMAGE');
        return checked('image/jpeg', buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3));
      }
      offset += length;
    }
    throw new Error('INVALID_IMAGE');
  }
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    if (buffer.readUInt32LE(4) + 8 > buffer.length) throw new Error('INVALID_IMAGE');
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      if (byteAt(buffer, 20) & 0x02) throw new Error('ANIMATED_IMAGE_UNSUPPORTED');
      const width = 1 + byteAt(buffer, 24) + (byteAt(buffer, 25) << 8) + (byteAt(buffer, 26) << 16);
      const height = 1 + byteAt(buffer, 27) + (byteAt(buffer, 28) << 8) + (byteAt(buffer, 29) << 16);
      return checked('image/webp', width, height);
    }
    if (chunk === 'VP8L' && byteAt(buffer, 20) === 0x2f) {
      const width = 1 + byteAt(buffer, 21) + ((byteAt(buffer, 22) & 0x3f) << 8);
      const height = 1 + (byteAt(buffer, 22) >> 6) + (byteAt(buffer, 23) << 2) + ((byteAt(buffer, 24) & 0x0f) << 10);
      return checked('image/webp', width, height);
    }
    if (chunk === 'VP8 ' && buffer.length >= 30 && byteAt(buffer, 23) === 0x9d && byteAt(buffer, 24) === 0x01 && byteAt(buffer, 25) === 0x2a) {
      return checked('image/webp', buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff);
    }
    throw new Error('INVALID_IMAGE');
  }
  throw new Error('UNSUPPORTED_IMAGE');
}

/** Header checks establish the accepted format and dimensions; decoding verifies the compressed pixel stream. */
export async function decodeImage(buffer: Buffer, expected: ImageMetadata): Promise<void> {
  try {
    const image = sharp(buffer, { failOn: 'warning', limitInputPixels: MAX_DECODED_BYTES / 4, animated: true });
    const metadata = await image.metadata();
    if (metadata.format !== expected.mediaType.slice('image/'.length) || metadata.width !== expected.width || metadata.height !== expected.height) throw new Error('INVALID_IMAGE');
    if ((metadata.pages ?? 1) > 1) throw new Error('ANIMATED_IMAGE_UNSUPPORTED');
    if (expected.width * expected.height * (metadata.channels ?? 4) > MAX_DECODED_BYTES) throw new Error('IMAGE_DIMENSIONS_UNSUPPORTED');
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    if (info.width !== expected.width || info.height !== expected.height || data.byteLength === 0 || data.byteLength > MAX_DECODED_BYTES) throw new Error('INVALID_IMAGE');
  } catch (error) {
    if (error instanceof Error && ['ANIMATED_IMAGE_UNSUPPORTED', 'IMAGE_DIMENSIONS_UNSUPPORTED'].includes(error.message)) throw error;
    throw new Error('INVALID_IMAGE');
  }
}
