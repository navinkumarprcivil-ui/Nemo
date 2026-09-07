/**
 * The poster recovery panel has to be ON SCREEN, not merely written.
 *
 * Posters live at media/img-<id> and the guide that shows one lives in `guides`. Losing the
 * guide therefore does not lose the poster — it only loses the thing that pointed at it, and
 * the image sits in the database unreferenced: invisible in Admin, impossible to delete, and
 * still paying for itself in storage. PosterRecovery exists to put those back against their
 * existing id so nothing is re-uploaded.
 *
 * It was defined and never rendered. A component nobody mounts is indistinguishable from a
 * missing feature, and it stayed that way through several releases, so the assertion that
 * matters is not that the function exists but that the Guides tab actually renders it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../app.jsx', import.meta.url), 'utf8');

test('the recovery panel is rendered, not just declared', () => {
  assert.match(src, /function PosterRecovery\(/, 'the component itself must still exist');
  assert.match(src, /<PosterRecovery products=\{products\} requests=\{requests\} guides=\{guides\} showcase=\{showcase\}/);
  // Restoring writes a guide, so it must be given the real save handler.
  assert.match(src, /onRestore=\{onSaveGuide\} showToast=\{showToast\}\/>/);
});

test('it sits in the Guides tab, where a missing poster is noticed', () => {
  const tab = src.slice(src.indexOf('{tab==="guides"&&canViewAdminSection'), src.indexOf('{tab==="settings"'));
  assert.ok(tab.includes('<PosterRecovery'), 'the panel belongs in Guides, beside the guides it repairs');
  assert.ok(tab.indexOf('+ Add Care Guide / Poster') < tab.indexOf('<PosterRecovery'),
    'adding a guide is the common action and stays first');
});

test('restoring reuses the poster id rather than uploading again', () => {
  // The whole point: the bytes are already in the database, so a restore must point at them.
  assert.match(src, /await repairPosterPointer\(id\);\n\s*await onRestore\(\{ id, title,/);
  assert.match(src, /hasImg:true,/);
});
