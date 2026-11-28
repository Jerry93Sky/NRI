import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { assetThumbnailKey, makeAssetThumbnail } from './assetThumbnail.js';

describe('campaign asset thumbnails', () => {
  it('generates a bounded WebP thumbnail without enlarging small images', async () => {
    const source = await sharp({ create: { width: 40, height: 24, channels: 4, background: '#345678' } }).png().toBuffer();
    const thumbnail = await makeAssetThumbnail(source);
    const result = await sharp(thumbnail).metadata();
    expect(result.format).toBe('webp');
    expect(result.width).toBe(40);
    expect(result.height).toBe(24);
  });

  it('fits large images inside the fixed thumbnail bounds', async () => {
    const source = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#345678' } }).png().toBuffer();
    const thumbnail = await makeAssetThumbnail(source);
    const result = await sharp(thumbnail).metadata();
    expect(result.format).toBe('webp');
    expect(result.width).toBeLessThanOrEqual(320);
    expect(result.height).toBeLessThanOrEqual(240);
  });

  it('derives a separate thumbnail path from the opaque original key', () => {
    expect(assetThumbnailKey('e'.repeat(48) + '.png')).toBe('e'.repeat(48) + '.thumb.webp');
  });
});
