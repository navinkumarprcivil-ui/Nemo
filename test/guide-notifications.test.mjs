/**
 * The care-guide notification switch.
 *
 * It reported "Blocked in browser" in three situations, only one of which was a block:
 * a dismissed prompt, a browser with no Notification API, and an actual denial. In all three
 * the switch was replaced by static text, so the customer could not even turn the preference
 * back OFF. These assertions pin the distinction and the escape route.
 *
 * The switch then stayed dead in one of those states for a different reason: with no
 * Notification API at all — which is every Android WebView, so the whole installed app — it
 * rendered `disabled`, and tapping it did nothing in either direction and said nothing. The
 * preference is the customer's and is now storable in every state; the permission only decides
 * whether a note appears underneath.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const file of ['app.jsx']) {
  const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('function GuideNotifBtn('), src.indexOf('function StockBadge('));

  test(file + ': a dismissed prompt is not recorded as a denial', () => {
    // The helper reports the browser's own outcome instead of a boolean.
    assert.match(src, /function requestNotifPerm\(cb\)\{[\s\S]*done\("unsupported"\)/);
    assert.match(src, /done\(p\|\|"default"\)/);
    // No caller may collapse the result back down to granted/denied.
    assert.doesNotMatch(src, /requestNotifPerm\(ok=>\{ setPerm\(ok\?"granted":"denied"\)/);
  });

  test(file + ': the switch never becomes a dead end', () => {
    // The old code returned static text whenever permission was denied, removing the control.
    assert.doesNotMatch(block, /Blocked in browser/);
    assert.match(block, /role="switch"/);
    // Turning OFF is a local preference and must work in every permission state.
    assert.match(block, /if\(on\)\{ apply\(false\); setNote\(""\); return; \}/);
  });

  test(file + ': an absent API is not reported as a block', () => {
    assert.match(block, /perm==="unsupported"/);
    assert.match(block, /can't show notifications/);
    // A real denial still points at where to undo it, rather than just stating the fact.
    assert.match(block, /Turn on notifications in settings/);
  });

  test(file + ': the switch is never disabled', () => {
    // `disabled` on a WebView (no Notification API) is what made this control dead in the app.
    assert.doesNotMatch(block, /disabled=\{/);
    assert.doesNotMatch(block, /cursor:off\?"not-allowed"/);
    // What the switch shows is the customer's preference, not the browser permission.
    assert.match(block, /const active = on;/);
  });

  test(file + ': turning it on records the preference before asking the browser', () => {
    const turnOn = block.slice(block.indexOf('const toggle=()=>{'), block.indexOf('\n  return('));
    const applyAt = turnOn.indexOf('apply(true);');
    const askAt = turnOn.indexOf('requestNotifPerm(');
    assert.ok(applyAt > -1 && askAt > -1, 'both the store and the request must be present');
    assert.ok(applyAt < askAt, 'the preference is stored first, so a refused prompt cannot discard it');
    // Every outcome the browser can return gets its own sentence.
    assert.match(block, /const noteFor=\(p\)=>/);
  });

  test(file + ': the app names itself when it cannot deliver', () => {
    // "This browser" is wrong wording inside the installed app, where there is no browser UI
    // for the customer to go and change.
    assert.match(block, /window\.nemoInApp/);
    /* And "the app can't show notifications yet" is no longer true of the app: it receives
       these through FCM and draws them natively, with no Notification API involved. It is only
       untrue of a build older than the one that added push, and for those the useful thing to
       say is how to fix it. */
    assert.doesNotMatch(block, /The app can't show notifications yet/);
    assert.match(block, /Saved\. Update the app to get these\./);
  });

  test(file + ': the switch subscribes on the server, not just on the device', () => {
    /* This was the whole bug. The preference was stored in localStorage and read by exactly one
       guard — sendLocalNotif's channel==="guides" — which no caller ever triggered. The switch
       moved, saved, and did nothing, in every browser and in the app. */
    assert.match(block, /const apply=\(v\)=>\{ setOn\(v\); setGuideNotifPref\(v\); syncGuideSub\(v,report\); \};/);
    assert.match(src, /function syncGuideSub\(on,done\)\{/);
    assert.match(src, /FB_DB\.ref\("guideSubs\/"\+uid\)/);
    // Opting out leaves no row, rather than a row saying no.
    assert.match(src, /if\(!on\)\{ try\{ ref\.remove\(\)/);
  });

  test(file + ': a preference set before signing in is filed once there is an owner', () => {
    // guideSubs is keyed on the account. Without this the switch reads ON while the server has
    // never heard of the customer.
    assert.match(block, /window\.addEventListener\("nemo-fb-ready",push\)/);
    assert.match(block, /const push=\(\)=>\{ if\(guideNotifOn\(\)\) syncGuideSub\(true,report\); \};/);
    assert.match(block, /const SIGNED_OUT="Saved\. Sign in to get these\.";/);
  });

  test(file + ': a refused subscription is shown, not only logged', () => {
    /* The one failure that produces pure silence. guideSubs needs a rule published by hand in
       the Firebase Console; without it the root ".write": false denies the write, the switch
       still reads ON and still says "Saved", and nothing ever arrives. A console warning is
       not a signal on a phone. */
    assert.match(src, /const fail=\(e\)=>\{ console\.warn\("nemo-push: guideSubs write rejected"/);
    assert.match(src, /ref\.set\(\{at:Date\.now\(\)\}\)\.then\(\(\)=>say\(""\),fail\);/);
    assert.match(block, /const NOT_SUBSCRIBED="Saved\. Couldn't subscribe you on the server\.";/);
    // Both routes to the server report it: the tap, and the re-file once auth resolves.
    const uses = block.match(/syncGuideSub\((?:v|true),report\)/g) || [];
    assert.equal(uses.length, 2, 'the tap and the sign-in re-file must both surface a refusal');
  });

  test(file + ': a refusal is not overwritten by a permission answer', () => {
    /* Both callbacks call setNote and they race. requestNotifPerm's resolves whenever the
       customer answers the browser dialog, which can be seconds after the Firebase write has
       already come back refused — and the refusal is the one that matters, because it is the
       only failure with no other symptom. Losing that race makes the note say the write
       succeeded when it did not, which is worse than saying nothing. */
    assert.match(block, /const subFailed=useRef\(false\);/);
    assert.match(block, /subFailed\.current = why==="rejected";/);
    assert.match(block, /const permNote=\(p\)=>\{ setPerm\(p\); if\(!subFailed\.current\) setNote\(noteFor\(p\)\); \};/);
    // The raw two-line callback that could clobber it must be gone from the request site.
    assert.match(block, /requestNotifPerm\(permNote\);/);
    assert.doesNotMatch(block, /requestNotifPerm\(res=>/);
  });

  test(file + ': the installed app is not asked about a permission it does not use', () => {
    // FCM delivery has nothing to do with the WebView's missing Notification API, so a device
    // that has handed us a token must not be apologised to.
    assert.match(src, /function pushCapable\(\)\{ return !!pendingPushToken; \}/);
    assert.match(block, /if\(pushCapable\(\)\)\{ setNote\(""\); return; \}/);
  });

  test(file + ': the dead notification channel is gone rather than left as a trap', () => {
    assert.doesNotMatch(src, /channel==="guides"/);
    assert.doesNotMatch(src, /undefined,"care"\)/);
    assert.match(src, /function sendLocalNotif\(title, body, icon="assets\/nemo-logo\.png"\)\{/);
  });

  test(file + ': the notes stay to one line and are legible on the header', () => {
    // The switch sits in the Care Guides header, a blue gradient. A four-line grey paragraph
    // there reads as an error, and C.textSub is picked for the off-white page, not for blue.
    const notes = block.match(/"Saved\.[^"]*"/g) || [];
    assert.ok(notes.length >= 4, 'every permission outcome still gets its own sentence');
    for (const n of notes) {
      assert.ok(n.length <= 52, `note is too long for the header corner: ${n}`);
    }
    assert.doesNotMatch(block, /role="status"[\s\S]{0,120}color:C\.textSub/);
  });

  test(file + ': permission changed outside the page is picked up', () => {
    assert.match(block, /visibilitychange/);
    assert.match(block, /navigator\.permissions\.query\(\{name:"notifications"\}\)/);
  });
}
