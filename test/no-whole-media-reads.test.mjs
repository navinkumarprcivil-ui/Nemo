/**
 * Nothing may read the whole `media` node.
 *
 * This is the guard for the failure that cost the store a month's allowance. `media` holds the
 * photos as base64 — 20 MB of a 20.8 MB database — and on 21 August a single line appeared in
 * api/product-page.js: `fetch(DB/media.json)`, to pick out a handful of image keys on every
 * request to /p. It read as harmless, and the route's Cache-Control header made it look like it
 * ran six times an hour. Both were wrong, and downloads went from ~200 MB a day to over a
 * gigabyte until it was found seventeen days later.
 *
 * A comment saying "don't do this" would not have stopped it, so this fails the build instead.
 * It covers every server file and the app, not just the one that regressed: the mistake was not
 * specific to that file, and the next one will not be either.
 *
 * Reading ONE key (`media/<key>.json`) is fine and expected — that is how an image that has not
 * been migrated to the CDN is still served. Listing key NAMES is fine too, with `shallow=true`,
 * which returns no values. It is pulling the values in bulk that is never acceptable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SCAN = ['api', 'lib', 'cloudflare', 'scripts'];

function sourceFiles() {
  const out = [join(ROOT, 'app.jsx')];
  for (const dir of SCAN) {
    const base = join(ROOT, dir);
    for (const name of readdirSync(base)) {
      const full = join(base, name);
      if (statSync(full).isFile() && /\.(js|mjs|jsx)$/.test(name)) out.push(full);
    }
  }
  return out;
}

test('no file fetches the media node whole', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const rel = file.slice(ROOT.length);
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      // `media/<key>.json` is a single image and is allowed; `media.json` is the entire node.
      if (!/[/`'"]media\.json/.test(line)) return;
      if (/shallow=true/.test(line)) return;            // key names only, no values
      offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(offenders, [], 'these pull every image in the database at once:\n' + offenders.join('\n'));
});

test('no file attaches to or reads the media node through the SDK', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const rel = file.slice(ROOT.length);
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      // ref("media") is the node itself. ref("media/"+key) and ref(`media/${key}`) are one image.
      const sdk = /\.ref\(\s*["'`]media["'`]\s*\)/.test(line);
      const helper = /db(?:Get|GetShallow)\(\s*["'`]media["'`]\s*\)/.test(line);
      if (!sdk && !helper) return;
      // Firebase Storage is a different service: listAll() returns file names and no bytes, and
      // it is not even enabled on this plan. Only the database is billed for downloads.
      if (/FB_STORAGE/.test(line)) return;
      offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(offenders, [], 'these read or subscribe to every image at once:\n' + offenders.join('\n'));
});

test('the guard would actually catch the line that caused the incident', () => {
  // A test that cannot fail is not a guard. This is the exact text of the regression, checked
  // against the same two rules, so the rules are known to match it rather than assumed to.
  const regression = "    const r = await fetch(`${DB}/media.json`, { signal: AbortSignal.timeout(5000) });";
  assert.match(regression, /[/`'"]media\.json/);
  assert.doesNotMatch(regression, /shallow=true/);
});

test('the SDK rule catches a database read but not a Storage listing', () => {
  const database = '    const s=await FB_DB.ref("media").get();';
  const storage  = '    const res=await FB_STORAGE.ref("media").listAll();';
  const server   = "    const all = await dbGet('media');";
  const oneImage = '    const s=await FB_DB.ref("media/"+key).get();';
  const rule = (line) => (/\.ref\(\s*["'`]media["'`]\s*\)/.test(line)
    || /db(?:Get|GetShallow)\(\s*["'`]media["'`]\s*\)/.test(line)) && !/FB_STORAGE/.test(line);
  assert.equal(rule(database), true);
  assert.equal(rule(server), true);
  assert.equal(rule(storage), false, 'Storage lists names and costs no download bandwidth');
  assert.equal(rule(oneImage), false, 'one un-migrated image is exactly what the fallback is for');
});

/* One whole-node read remains and is deliberate: downloadFullBackup lists "media" among the
   nodes it exports, so a backup is a genuine 20 MB download. It reaches the node through a
   variable, so no static rule can see it — it is named here instead, because the next person
   wondering where a sudden 20 MB went should find it in the same file as everything else. */
