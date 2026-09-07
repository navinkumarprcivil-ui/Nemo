/**
 * Regenerate CDN_MEDIA_KEYS in app.jsx from what is actually in assets/media/.
 *
 * The list is what tells the app an image can be fetched from Cloudflare instead of read out
 * of the Realtime Database. It has to match the directory exactly in both directions: a key
 * listed with no file behind it is a broken image, and a file no one lists is a database read
 * that did not need to happen. Hand-maintaining it would drift the first time anyone adds a
 * photo, so it is generated — and test/cdn-media.test.mjs fails the build if it is stale.
 *
 * Run after adding or removing anything in assets/media/:  node scripts/sync-media-list.mjs
 */
import { readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MEDIA_DIR = join(ROOT, 'assets', 'media');
const START = '/* __MEDIA_LIST_START__ */';
const END = '/* __MEDIA_LIST_END__ */';

/** Every media key with a file on the CDN, sorted so the generated diff is stable. */
export function mediaKeysOnDisk() {
  if (!existsSync(MEDIA_DIR)) return [];
  return readdirSync(MEDIA_DIR)
    .filter((f) => f.toLowerCase().endsWith('.jpg'))
    .map((f) => f.slice(0, -4))
    .sort();
}

/** The list as app.jsx currently declares it. */
export function mediaKeysInSource(src) {
  const a = src.indexOf(START);
  const b = src.indexOf(END, a);
  if (a < 0 || b < 0) throw new Error('CDN_MEDIA_KEYS markers not found in app.jsx');
  return [...src.slice(a + START.length, b).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

export function renderList(keys) {
  return keys.length ? '\n' + keys.map((k) => `  "${k}",`).join('\n') + '\n  ' : '\n  ';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = join(ROOT, 'app.jsx');
  const src = readFileSync(file, 'utf8');
  const keys = mediaKeysOnDisk();
  const a = src.indexOf(START);
  const b = src.indexOf(END, a);
  if (a < 0 || b < 0) throw new Error('CDN_MEDIA_KEYS markers not found in app.jsx');
  const next = src.slice(0, a + START.length) + renderList(keys) + src.slice(b);
  if (next === src) { console.log(`app.jsx already lists ${keys.length} CDN image(s)`); process.exit(0); }
  writeFileSync(file, next);
  console.log(`app.jsx now lists ${keys.length} CDN image(s) from assets/media/`);
}
