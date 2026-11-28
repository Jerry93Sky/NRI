import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const [, , directory, inventory, state] = process.argv;
assert.ok(directory && inventory && (!state || state === '--quiesced'), 'Usage: node scripts/inventory-media.mjs <media-directory> <asset-metadata.json> [--quiesced]');
const root = resolve(directory);
const rootInfo = await lstat(root);
assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink() && await realpath(root) === root, 'Use the real media directory');
const input = JSON.parse(await readFile(inventory, 'utf8'));
assert.ok(Array.isArray(input));
const quiesced = state === '--quiesced';
const threshold = Date.now() - 24 * 60 * 60 * 1000;
const references = new Map();
const thumbnailKeys = new Set();
const list = {
  referencedOriginals: 0, matchedOriginals: 0, missingOriginals: 0, damagedOriginals: 0,
  presentThumbnails: 0, missingThumbnails: 0, incompleteThumbnails: 0,
  unreferencedOriginals: 0, unreferencedThumbnails: 0, freshStaging: 0, oldStaging: 0, unknown: 0,
};

function add(item) {
  assert.ok(item && typeof item.storageKey === 'string' && item.storageKey === basename(item.storageKey) && /^[a-z0-9][a-z0-9._-]*$/i.test(item.storageKey));
  assert.ok(Number.isSafeInteger(Number(item.size)) && Number(item.size) >= 0);
  assert.match(item.checksum, /^[a-f0-9]{64}$/i);
  assert.ok(!references.has(item.storageKey), 'Duplicate asset storage key');
  const thumbnail = item.storageKey.replace(/\.[^.]+$/u, '') + '.thumb.webp';
  references.set(item.storageKey, { ...item, thumbnail });
  thumbnailKeys.add(thumbnail);
}

for (const asset of input) add(asset);
list.referencedOriginals = references.size;
const files = new Map();
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isFile() || entry.isSymbolicLink()) { list.unknown++; continue; }
  const info = await lstat(join(root, entry.name));
  if (!info.isFile() || info.isSymbolicLink()) { list.unknown++; continue; }
  files.set(entry.name, info);
  if (references.has(entry.name) || thumbnailKeys.has(entry.name)) continue;
  if (/^(?:\.asset-[a-f0-9]{32}|\.(?:campaign-copy|amber-playable)-[a-f0-9-]{36})\.pending$/i.test(entry.name)) {
    if (info.mtimeMs >= threshold) list.freshStaging++; else list.oldStaging++;
  } else if (entry.name.endsWith('.thumb.webp')) list.unreferencedThumbnails++;
  else if (/^[a-f0-9]{48}\.(png|jpe?g|webp)$/i.test(entry.name)) list.unreferencedOriginals++;
  else list.unknown++;
}

for (const [key, { size, checksum, thumbnail }] of references) {
  const original = files.get(key);
  if (!original) list.missingOriginals++;
  else if (original.size !== Number(size)) list.damagedOriginals++;
  else {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(join(root, key))) hash.update(chunk);
    if (hash.digest('hex') === checksum.toLowerCase()) list.matchedOriginals++; else list.damagedOriginals++;
  }
  const thumb = files.get(thumbnail);
  if (!thumb) { list.missingThumbnails++; continue; }
  const descriptor = await open(join(root, thumbnail), 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await descriptor.read(header, 0, header.length, 0);
    const complete = bytesRead === header.length && header.toString('ascii', 0, 4) === 'RIFF'
      && header.toString('ascii', 8, 12) === 'WEBP' && header.readUInt32LE(4) + 8 === thumb.size;
    if (complete) list.presentThumbnails++; else list.incompleteThumbnails++;
  } finally { await descriptor.close(); }
}

console.info(JSON.stringify({ mode: quiesced ? 'quiesced dry-run' : 'live observations only', ...list }, null, 2));
