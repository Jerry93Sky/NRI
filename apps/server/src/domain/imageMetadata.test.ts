import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { decodeImage, inspectImage } from './imageMetadata.js';

function pngHeader(width: number, height: number) {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.writeUInt32BE(13, 8); buffer.write('IHDR', 12, 'ascii'); buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe('image metadata validation', () => {
  it('reads PNG dimensions and bounds decoded pixel memory', () => {
    expect(inspectImage(pngHeader(512, 256))).toEqual({ mediaType: 'image/png', width: 512, height: 256 });
    expect(() => inspectImage(pngHeader(8192, 8192))).toThrow('IMAGE_DIMENSIONS_UNSUPPORTED');
  });

  it('rejects malformed and active image formats', () => {
    expect(() => inspectImage(Buffer.from('<svg><script/>'))).toThrow('UNSUPPORTED_IMAGE');
    const webp = Buffer.alloc(30); webp.write('RIFF', 0); webp.writeUInt32LE(22, 4); webp.write('WEBP', 8); webp.write('VP8X', 12); webp[20] = 0x02;
    expect(() => inspectImage(webp)).toThrow('ANIMATED_IMAGE_UNSUPPORTED');
  });

  it('decodes supported image bytes and rejects truncated pixel streams', async () => {
    const pixels = randomBytes(128 * 128 * 4);
    const valid = await sharp(pixels, { raw: { width: 128, height: 128, channels: 4 } }).png().toBuffer();
    const metadata = inspectImage(valid);
    await expect(decodeImage(valid, metadata)).resolves.toBeUndefined();
    let offset = 8;
    let truncated = valid;
    while (offset + 8 < valid.length) {
      const length = valid.readUInt32BE(offset);
      if (valid.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
        truncated = valid.subarray(0, offset + 8 + Math.floor(length / 2));
        break;
      }
      offset += length + 12;
    }
    expect(truncated).not.toBe(valid);
    await expect(decodeImage(truncated, metadata)).rejects.toThrow('INVALID_IMAGE');
  });
});
