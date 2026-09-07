/**
 * Server-side payment plumbing — authenticated Realtime Database access, shared by
 * every gateway. The gateways themselves live in lib/gateways.mjs.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The store once had no server in the purchase path: the browser wrote the
 * order, the customer paid by UPI out of band, and the owner eyeballed a
 * screenshot. That works while one person is checking every order by hand, and
 * it stops working the moment payment is meant to confirm an order on its own.
 *
 * A browser cannot be trusted to say "this was paid" — anyone can send that
 * message. So confirmation happens on the server: the gateway signs a webhook,
 * lib/gateways.mjs verifies it against a secret the browser never sees, re-reads
 * the order through this module, checks the amount actually paid matches the
 * amount the order says is due, and only then moves the order forward.
 *
 * That proves the gateway collected the exact amount frozen on the Nemo order.
 * Production payments therefore move directly to Confirmed. Shipping and delivery
 * remain explicit fulfilment actions for the owner.
 *
 * ── No dependencies, on purpose ────────────────────────────────────────────
 * The rest of api/ is plain ESM against `fetch`. The gateways are REST APIs and
 * the Google credentials are ordinary JWTs, so both are reachable with `fetch`
 * and node:crypto. Adding firebase-admin and a gateway SDK would mean an
 * install step on every deploy to save perhaps eighty lines.
 *
 * ── Configuration ──────────────────────────────────────────────────────────
 * Everything is read from environment variables, and every entry point fails
 * safely when credentials are absent. See docs/PAYMENTS.md.
 *
 *   FIREBASE_SERVICE_ACCOUNT service-account JSON, whole file, one line
 *
 * The gateway credentials are documented in lib/gateways.mjs, which owns them.
 */

import crypto from 'node:crypto';

export const PROJECT_ID = 'nemo-aqua-store';
export const DB = 'https://nemo-aqua-store-default-rtdb.asia-southeast1.firebasedatabase.app';

/** True once the server can write to the database as itself — required by every gateway. */
export const firebaseReady = () => !!serviceAccount();

/* ─────────────────────────── Google / Firebase auth ─────────────────────── */

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!raw) return null;
  try {
    // Accept the JSON as-is or base64-wrapped: pasting a multi-line private key
    // into a dashboard field mangles it often enough to be worth allowing both.
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const sa = JSON.parse(text);
    if (!sa.client_email || !sa.private_key) return null;
    sa.private_key = String(sa.private_key).replace(/\\n/g, '\n');
    return sa;
  } catch { return null; }
}

let tokenCache = { token: '', exp: 0 };
/**
 * An OAuth access token for the service account, good for writing to the
 * database as an authenticated principal. Cached until shortly before it
 * expires — a webhook burst should not mint a token per request.
 *
 * Exported because lib/push.mjs needs the same credential to reach FCM. The
 * cache stays here rather than moving to a third module: one cache means one
 * token in flight, which is the whole point of caching it.
 */
export async function accessToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const sa = serviceAccount();
  if (!sa) throw new Error('FIREBASE_SERVICE_ACCOUNT not configured');

  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    /* firebase.messaging is here so one cached token serves both the database and FCM.
       Scopes on a JWT-bearer grant are self-asserted — the exchange succeeds whatever we
       ask for, and IAM decides at the call itself — so adding this cannot break the
       database access that every gateway depends on. */
    scope: 'https://www.googleapis.com/auth/firebase.database'
      + ' https://www.googleapis.com/auth/firebase.messaging'
      + ' https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claim));
  const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), sa.private_key));

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${body}.${sig}`,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status}`);
  const t = await r.json();
  tokenCache = { token: t.access_token, exp: Date.now() + (t.expires_in - 120) * 1000 };
  return tokenCache.token;
}

/** Read a database path as the service account (bypasses the public read rules). */
export async function dbGet(path) {
  const tok = await accessToken();
  const r = await fetch(`${DB}/${path}.json?access_token=${encodeURIComponent(tok)}`,
    { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`db read ${path}: ${r.status}`);
  return r.json();
}

/**
 * Key names at a path, without their values.
 *
 * `?shallow=true` returns `{key: true}` instead of the data underneath. That matters wherever a
 * node holds base64 images: reading showcase/ in full to learn which entries had expired pulled
 * every tank photo down on every cron tick, ninety-six times a day, for a handful of timestamps.
 * The bytes are billed the same whether a customer or the service account asks for them.
 */
export async function dbGetShallow(path) {
  const tok = await accessToken();
  const r = await fetch(`${DB}/${path}.json?shallow=true&access_token=${encodeURIComponent(tok)}`,
    { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`db shallow read ${path}: ${r.status}`);
  return r.json();
}

/** Merge fields into a database path as the service account. */
export async function dbPatch(path, obj) {
  const tok = await accessToken();
  const r = await fetch(`${DB}/${path}.json?access_token=${encodeURIComponent(tok)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(obj),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`db write ${path}: ${r.status}`);
  return r.json();
}

/** Delete one database path as the service account. */
export async function dbDelete(path) {
  const tok = await accessToken();
  const r = await fetch(`${DB}/${path}.json?access_token=${encodeURIComponent(tok)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`db delete ${path}: ${r.status}`);
  return r.json();
}

/** Optimistic Realtime Database transaction using REST ETags. */
export async function dbTransaction(path, update, attempts = 6) {
  const tok = await accessToken();
  const url = `${DB}/${path}.json?access_token=${encodeURIComponent(tok)}`;
  for (let i = 0; i < attempts; i += 1) {
    const read = await fetch(url, {
      headers: { 'X-Firebase-ETag': 'true' },
      signal: AbortSignal.timeout(8000),
    });
    if (!read.ok) throw new Error(`db transaction read ${path}: ${read.status}`);
    const current = await read.json();
    const next = update(current);
    if (next === undefined) return current;
    const write = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-match': read.headers.get('etag') || '*' },
      body: JSON.stringify(next),
      signal: AbortSignal.timeout(8000),
    });
    if (write.status === 412) continue;
    if (!write.ok) throw new Error(`db transaction write ${path}: ${write.status}`);
    return write.json();
  }
  throw new Error(`db transaction conflict ${path}`);
}

/* ───────────────────────── Verifying the caller ─────────────────────────── */

let certCache = { keys: null, exp: 0 };
async function googleCerts() {
  if (certCache.keys && Date.now() < certCache.exp) return certCache.keys;
  const r = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com',
    { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('cert fetch failed');
  const keys = await r.json();
  // Honour the cache header rather than guessing; Google rotates these.
  const cc = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  certCache = { keys, exp: Date.now() + (cc ? Number(cc[1]) : 3600) * 1000 };
  return keys;
}

/**
 * Verify a Firebase ID token and return its uid, or null.
 *
 * The refund endpoint moves real money, so "the client said it was the admin"
 * is not good enough — the caller proves it with a token Google signed, and the
 * signature is checked here against Google's public certificates.
 */
export async function verifyIdToken(idToken) {
  try {
    const [h, p, s] = String(idToken || '').split('.');
    if (!h || !p || !s) return null;
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (header.alg !== 'RS256' || !header.kid) return null;

    const now = Math.floor(Date.now() / 1000);
    if (payload.aud !== PROJECT_ID) return null;
    if (payload.iss !== `https://securetoken.google.com/${PROJECT_ID}`) return null;
    if (!payload.sub || Number(payload.exp) <= now || Number(payload.iat) > now + 300) return null;

    const cert = (await googleCerts())[header.kid];
    if (!cert) return null;
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`),
      crypto.createPublicKey(cert), Buffer.from(s, 'base64url'));
    return ok ? payload.sub : null;
  } catch { return null; }
}

const PRIMARY_ADMIN_UID = 'cI2HmMt6FdR7fO7uUnugH85GeZt2';
/** Sandbox checkout and refunds are restricted to verified store administrators. */
export async function isPaymentAdmin(uid) {
  if (!uid) return false;
  const configured = String(process.env.PAYMENT_ADMIN_UIDS || '')
    .split(',').map(value => value.trim()).filter(Boolean);
  if (uid === PRIMARY_ADMIN_UID || configured.includes(uid)) return true;
  try {
    const privateSettings = await dbGet('settingsPrivate');
    return uid === String(privateSettings?.coAdminUid || '').trim();
  } catch { return false; }
}

/* ──────────────────────────── Money and ids ─────────────────────────────── */

/** Every gateway prices in rupees with at most two decimal places. */
export const money = (rupees) => Math.round(Number(rupees || 0) * 100) / 100;
export const sameMoney = (left, right) => Math.round(Number(left) * 100) === Math.round(Number(right) * 100);

/** Stable UUID so a retry of the same operation remains idempotent at the gateway. */
export function stableUuid(value) {
  const bytes = crypto.createHash('sha256').update(String(value)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Read the untouched request body — webhook verification must not use parsed/re-serialized JSON. */
export async function rawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString('utf8');
}

/* ────────────────────────────── Order lookup ────────────────────────────── */

/**
 * Orders live under orders/<userUid>/<orderId>. The gateway's own order id is mapped
 * server-side to that path (see readGatewayMapping in lib/gateways.mjs); a webhook never
 * gets to choose which customer order it mutates from untrusted request fields.
 */
export const orderPath = (userUid, orderId) =>
  `orders/${encodeURIComponent(userUid)}/${encodeURIComponent(orderId)}`;

export async function readOrder(userUid, orderId) {
  if (!userUid || !orderId) return null;
  try { return await dbGet(orderPath(userUid, orderId)); } catch { return null; }
}

/* Consume the referral code this buyer used, driven by the same verified payment event as the
   order. The reservation written at checkout is checked first, so a code copied from someone
   else's checkout can never be won by a later payer. Gateways deliver duplicate paid events, so
   the write is idempotent — a second delivery finds the redemption already recorded and stops.

   Only `kind:"customer"` codes are honoured. The per-order single-use code this also used to
   activate is retired; records of that kind are left untouched and simply never consume. */
const referralCode = (v) => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
const referralPath = (code) => `referrals/${encodeURIComponent(referralCode(code))}`;

export async function settleReferralsAfterPayment(order, userUid, orderId, now = Date.now()) {
  if (!order || order.status === 'Cancelled') return false;

  const used = referralCode(order.referralCode);
  if (!used) return false;
  const path = referralPath(used);
  let consumed = false;
  await dbTransaction(path, record => {
    consumed = false;
    if (!record || record.active !== true) return undefined;
    if (record.kind === 'customer') {
      if (record.redemptions && record.redemptions[userUid]) return undefined;
      const pending = record.pendingBy && record.pendingBy[userUid];
      if (!pending || pending.orderId !== orderId) return undefined;
      const pendingBy = { ...(record.pendingBy || {}) };
      delete pendingBy[userUid];
      consumed = true;
      return { ...record, pendingBy, redemptions: { ...(record.redemptions || {}), [userUid]: { orderId, usedAt: now } } };
    }
    return undefined;
  });
  return consumed;
}
