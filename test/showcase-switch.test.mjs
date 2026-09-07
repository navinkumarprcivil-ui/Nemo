/**
 * An OFF switch has to stop the READ, not merely the render.
 *
 * showcaseEnabled was honoured in exactly one place — TankShowcaseSection returning null — so
 * an owner who switched the tank showcase off got a hidden gallery and an unchanged bill: the
 * boot listener still pulled the whole `showcase` node on every visit. That node is the most
 * expensive in the store, because an entry carries up to three base64 photos inline, and on
 * the free plan the download allowance is what stands between the shop and being cut off for
 * the rest of the billing cycle.
 *
 * The same applied to testimonials.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../app.jsx', import.meta.url), 'utf8');
const effect = src.slice(
  src.indexOf('let showcaseSettled=false, testimonialsSettled=false;'),
  src.indexOf('// CUSTOMER: live listener on THEIR orders'),
);

test('the listeners are attached only when the feature is on', () => {
  assert.match(effect, /const wantShowcase = settings\.showcaseEnabled!==false;/);
  assert.match(effect, /const wantTestimonials = settings\.testimonialsEnabled!==false;/);
  assert.match(effect, /if\(wantShowcase\)\{\n\s*const scRef=FB_DB\.ref\("showcase"\);/);
  assert.match(effect, /if\(wantTestimonials\)\{\n\s*const tsRef=FB_DB\.ref\("testimonials"\);/);
});

test('the decision waits for the owner’s real settings', () => {
  /* The default is ON. Deciding before the saved settings arrive would attach, download the
     whole node, and only then detach — paying the cost this exists to avoid. */
  assert.match(effect, /if\(settingsReady\) start\(\);/);
  assert.match(effect, /\},\[fbReady,settingsReady,settings\.showcaseEnabled,settings\.testimonialsEnabled\]\);/);
});

test('a skipped listener still settles, so boot is not held to the guard', () => {
  // settle() gates first paint. A listener that never attaches must report empty immediately,
  // or every visitor waits out the 8-second failure guard before the store appears.
  assert.match(effect, /\} else useShowcase\(\[\]\);/);
  assert.match(effect, /\} else useTestimonials\(\[\]\);/);
  assert.match(effect, /wantShowcase\?loadShowcase\(\)\.then\(useShowcase\)\.catch\(\(\)=>useShowcase\(\[\]\)\):useShowcase\(\[\]\)/);
});

test('detaching still removes whichever listeners were attached', () => {
  assert.match(effect, /const offs=\[\];/);
  assert.match(effect, /offs\.push\(\(\)=>\{ try\{ scRef\.off\("value",scCb\); \}catch\(e\)\{\} \}\);/);
  assert.match(effect, /detach=\(\)=>\{ offs\.forEach\(f=>f\(\)\); \};/);
});
