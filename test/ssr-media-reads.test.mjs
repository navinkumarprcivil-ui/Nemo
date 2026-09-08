/**
 * The server-rendered pages must not read image bytes out of the database.
 *
 * /p and /p/<slug> called `fetch(DB/media.json)` on every request to pick out a handful of
 * keys — the whole 20 MB node. The Cache-Control header on that route promised ten minutes at
 * the edge, but a Worker returning a response it built itself does not populate Cloudflare's
 * cache, so nothing was ever cached and every crawler hit paid in full. That single line was
 * most of a 1.2 GB day against a 10 GB month.
 *
 * These tests pin the shape of the fix: URLs, never bytes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hydrateCatalogueMedia } from '../api/product-page.js';
import { CDN_MEDIA_KEYS } from '../lib/media-cdn.mjs';

const BASE = 'https://www.nemoaquastore.in';
const onCdn = CDN_MEDIA_KEYS[0];
const pageSrc = readFileSync(new URL('../api/product-page.js', import.meta.url), 'utf8');
const workerSrc = readFileSync(new URL('../cloudflare/worker.js', import.meta.url), 'utf8');

test('rendering a product page reads nothing from the database', () => {
  assert.doesNotMatch(pageSrc, /media\.json/, 'the whole-node read is back');
  assert.doesNotMatch(pageSrc, /firebasedatabase\.app/, 'the page is talking to the database again');
});

test('a key with a CDN file resolves to the CDN, costing the database nothing', () => {
  const cat = { products: [{ id: 'p1', media: [{ type: 'image', key: onCdn }] }] };
  hydrateCatalogueMedia(cat);
  assert.equal(cat.products[0].media[0].url, `${BASE}/assets/media/${onCdn}.jpg`);
});

test('a key with no CDN file resolves to the one-key route, not to base64', () => {
  const cat = { products: [{ id: 'p1', media: [{ type: 'image', key: 'img-brandnew123' }] }] };
  hydrateCatalogueMedia(cat);
  // A URL a crawler can fetch. og:image was a base64 data URL before, which none of them can.
  assert.equal(cat.products[0].media[0].url, `${BASE}/share-image/img-brandnew123`);
});

test('a URL already on the product wins, and a video is left alone', () => {
  const cat = { products: [{ id: 'p1', media: [
    { type: 'image', key: onCdn, url: 'https://cdn.example/own.jpg' },
    { type: 'video', key: 'v1' },
  ] }] };
  hydrateCatalogueMedia(cat);
  assert.equal(cat.products[0].media[0].url, 'https://cdn.example/own.jpg');
  assert.deepEqual(cat.products[0].media[1], { type: 'video', key: 'v1' });
});

test('no thumbnail is invented for an item that never had one', () => {
  // /share-image/<key>_thumb for a thumb that was never made serves the share banner, which
  // would show the store banner where the product photo belongs.
  const cat = { products: [{ id: 'p1', media: [{ type: 'image', key: 'img-brandnew123' }] }] };
  hydrateCatalogueMedia(cat);
  assert.equal(cat.products[0].media[0].thumbUrl, undefined);

  const flagged = { products: [{ id: 'p1', media: [{ type: 'image', key: 'img-brandnew123', thumb: 1 }] }] };
  hydrateCatalogueMedia(flagged);
  assert.equal(flagged.products[0].media[0].thumbUrl, `${BASE}/share-image/img-brandnew123_thumb`);
});

test('a legacy single image is only claimed when the product says it has one', () => {
  const withImg = { products: [{ id: 'abc', hasImg: true, media: [] }] };
  hydrateCatalogueMedia(withImg);
  assert.equal(withImg.products[0].media[0].url, `${BASE}/share-image/img-abc`);

  const without = { products: [{ id: 'abc', media: [] }] };
  hydrateCatalogueMedia(without);
  assert.deepEqual(without.products[0].media, []);
});

test('the share-image route sends CDN keys to the CDN instead of reading the database', () => {
  assert.match(workerSrc, /const path = cdnMediaPath\(key\);[\s\S]{0,400}status: 302/);
  // And the database path stays for everything uploaded since the migration.
  assert.match(workerSrc, /\$\{MEDIA_DB\}\/media\/\$\{encodeURIComponent\(key\)\}\.json/);
});
