/**
 * The CDN image list has to describe reality.
 *
 * Product photos and guide posters used to be base64 inside the Realtime Database, and
 * hydrateMedia loads every gallery image on boot — so a fresh visitor pulled most of a 20 MB
 * node on any page. On the free plan that was 1.2 GB a day against a 10 GB month, which ends
 * with the database cut off and the shop down until the cycle resets.
 *
 * The fix reads them from Cloudflare instead. CDN_MEDIA_KEYS is what decides, per key, whether
 * to do that, so it must match assets/media/ exactly in BOTH directions: a listed key with no
 * file is a broken image on a customer's screen, and a file nobody lists is a database read
 * that did not need to happen — the very cost this removes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mediaKeysOnDisk, mediaKeysInSource, LIST_FILES } from '../scripts/sync-media-list.mjs';

const src = readFileSync(new URL('../app.jsx', import.meta.url), 'utf8');
const listing = (rel) => mediaKeysInSource(readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'), rel);

for (const rel of LIST_FILES) {
  test(`${rel}: every listed key has a file, and every file is listed`, () => {
    const disk = mediaKeysOnDisk();
    const listed = listing(rel);
    const missing = listed.filter((k) => !disk.includes(k));
    const unlisted = disk.filter((k) => !listed.includes(k));
    assert.deepEqual(missing, [], 'listed but absent from assets/media/ — these render broken');
    assert.deepEqual(unlisted, [], 'in assets/media/ but unlisted — run node scripts/sync-media-list.mjs');
  });

  test(`${rel}: the list is sorted, so its diff stays readable`, () => {
    const listed = listing(rel);
    assert.deepEqual(listed, [...listed].sort());
  });
}

test('the browser copy and the server copy agree', () => {
  // They are separate only because app.jsx is transformed, not bundled, and cannot import.
  // If they ever disagree, one surface reads the database for an image the other does not.
  const [first, ...rest] = LIST_FILES.map(listing);
  rest.forEach((other) => assert.deepEqual(other, first));
});

test('both media readers consult the CDN before the database', () => {
  // loadImg covers guide posters and legacy single images; loadMediaItem covers the galleries.
  assert.match(src, /const c=cdnMediaPath\("img-"\+id\); if\(c\)return c; if\(FB_OK\)/);
  assert.match(src, /const cdn=cdnMediaPath\(key\); if\(cdn\) return cdn;[\s\S]{0,120}FB_DB\.ref\("media\/"\+key\)/);
  // The local cache still wins, or the app stops working offline.
  assert.match(src, /const cached=await mediaGet\("nemo-m-"\+key\); if\(cached\)return cached;\n\s*\/\/ Then the CDN/);
});

test('a key with no CDN file still falls through to the database', () => {
  // Anything uploaded after the migration is not in the list and must keep working untouched.
  assert.match(src, /function cdnMediaPath\(key\)\{ return \(key&&CDN_MEDIA\.has\(key\)\)\?\("assets\/media\/"\+key\+"\.jpg"\):null; \}/);
});
