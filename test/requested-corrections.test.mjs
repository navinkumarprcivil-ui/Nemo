import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(root, 'app.jsx'), 'utf8');
const rules = JSON.parse(readFileSync(join(root, 'database.rules.json'), 'utf8')).rules;
const cleanupApi = readFileSync(join(root, 'api/cron-tank-cleanup.js'), 'utf8');
const restoreApi = readFileSync(join(root, 'api/loyalty-restore.js'), 'utf8');

test('checkout keeps only the requested Special Request label', () => {
  assert.match(app, />Special Request <span/);
  assert.doesNotMatch(app, /Tell us anything special about your order/);
  assert.doesNotMatch(app, /what you type is kept as you go/);
  assert.doesNotMatch(app, /Order Summary \/ Special Requests?/);
});

test('saved addresses and WhatsApp updates are explicit opt-ins', () => {
  assert.match(app, />📍 Saved Address</);
  assert.match(app, />Save this address for future orders</);
  assert.match(app, />Update me on WhatsApp</);
  assert.match(app, /addr\.waUpdates&&inp\("WhatsApp Number"/);
  assert.match(app, /if\(onSaveAddress&&saveForLater&&!addrEditId\)/);
  assert.match(app, /setSavedAddresses\(loadSavedAddresses\(uk\)\)/);
  assert.doesNotMatch(app, /FROM A PAST ORDER/);
  assert.doesNotMatch(app, /Addresses from past orders reappear/);
  assert.doesNotMatch(app, /seedAddressBook/);
});

test('the order review prompt links products and asks customers to share a review', () => {
  const reviewBlock = app.slice(app.indexOf('function ProductReviewPrompt('), app.indexOf('/* ═══════════════════ ORDER HISTORY PAGE'));
  assert.match(reviewBlock, /Share review/);
  assert.match(reviewBlock, /onWriteReview\(prod\)/);
  assert.doesNotMatch(reviewBlock, /service|packing|shipping|experience/i);
  assert.doesNotMatch(app, /How was your order|Rate your order|Experience Feedback/);
});

test('DOA offers the customer refund or reward coins and no replacement choice', () => {
  const itemDoa = app.slice(app.indexOf('function ItemDoaBlock('), app.indexOf('function OrderHistoryPage('));
  assert.match(itemDoa, /\[\["refund","💸 Refund"\],\["coins","🪙 Reward coins"\]\]/);
  assert.doesNotMatch(itemDoa, /replacement/i);
  assert.match(itemDoa, /Choose your resolution/);
});

test('the floating cart remains enabled on product detail pages', () => {
  assert.match(app, /cart\.length>0 && !\["cart","checkout","auth"\]\.includes\(page\)/);
  assert.doesNotMatch(app, /\["cart","checkout","auth","detail"\]/);
});

test('payment, referral, wallet and tank lifecycle guards are server-enforced', () => {
  const orderRules = rules.orders.$uid.$oid;
  assert.match(orderRules.status['.validate'], /!data\.exists\(\).*Awaiting Payment/);
  assert.match(orderRules.status['.validate'], /data\.val\(\) === 'Payment Review'.*Cancelled/);
  assert.match(orderRules.paymentStatus['.validate'], /'Verified'.*'Paid'/);
  assert.match(rules.userrefs.$uid['.validate'], /referralLifetimeSpendMin/);
  assert.match(rules.showcase.$id['.write'], /approvedAt.*expiresAt/);
  assert.match(rules.totmVotes.$month.$entry.$day.$voter['.write'], /expiresAt.*now/);
  /* The sweep is keyed off the node's OWN key, never a field inside the entry — a row whose
     `id` disagreed with its key would otherwise leave the real row behind forever. It reads
     shallow because each entry carries a base64 tank photo, and pulling the node whole to read
     five timestamps downloaded every customer's picture on every tick. */
  assert.match(cleanupApi, /Object\.keys\(await dbGetShallow\('showcase'\) \|\| \{\}\)/);
  assert.match(cleanupApi, /dbGet\(`showcase\/\$\{id\}\/\$\{f\}`\)/);
  assert.doesNotMatch(cleanupApi, /await dbGet\('showcase'\)/);
  assert.doesNotMatch(cleanupApi, /encodeURIComponent\(entry\.id\)/);
  assert.match(restoreApi, /entry\.type === 'redeem'/);
  assert.match(restoreApi, /redemption-not-found/);
});
