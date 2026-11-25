import sharp from 'sharp';

const MAX_PIXELS = 16_777_216;
const THUMBNAIL_WIDTH = 320;
const THUMBNAIL_HEIGHT = 240;

export async function makeAssetThumbnail(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer, { failOn: 'warning', limitInputPixels: MAX_PIXELS })
    .rotate()
    .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
}

export function assetThumbnailKey(storageKey: string): string {
  const extension = storageKey.lastIndexOf('.');
  return `${extension > 0 ? storageKey.slice(0, extension) : storageKey}.thumb.webp`;
}
