/** Remove pending and approved customer-tank entries once their 24-hour window ends. */
import { dbGet, dbGetShallow, dbDelete } from '../lib/payments.mjs';

const TTL = 24 * 60 * 60 * 1000;

/* Pending time starts at submission. Approved time is a separate window that starts only when
   the admin approves. Explicit numeric expiries win; the date fallbacks keep legacy rows clean. */
export const tankEntryExpiry = (entry) => {
  if (!entry) return 0;

  if (entry.approved === false) {
    const pending = Number(entry.pendingExpiresAt) || 0;
    if (pending > 0) return pending;
    const submitted = Date.parse(entry.createdAt || '');
    return Number.isFinite(submitted) ? submitted + TTL : 0;
  }

  const approved = Number(entry.expiresAt) || 0;
  if (approved > 0) return approved;
  const approvedAt = Date.parse(entry.approvedAt || entry.createdAt || '');
  return Number.isFinite(approvedAt) ? approvedAt + TTL : 0;
};

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).end(); return; }
  const secret = process.env.CRON_SECRET || '';
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    /* Never read `showcase` whole. Each entry carries a base64 tank photo, so pulling the node
       to inspect five timestamps downloaded every customer's picture — on every tick, ninety-six
       times a day — and the free plan's download allowance is what stands between this shop and
       being cut off for the rest of the billing cycle. The shallow read returns key names only,
       and the fields below are scalars worth a few bytes each. */
    const keys = Object.keys(await dbGetShallow('showcase') || {});
    const now = Date.now();
    const FIELDS = ['approved', 'pendingExpiresAt', 'expiresAt', 'approvedAt', 'createdAt'];
    const entries = await Promise.all(keys.map(async (key) => {
      const id = encodeURIComponent(key);
      const values = await Promise.all(
        FIELDS.map((f) => dbGet(`showcase/${id}/${f}`).catch(() => null)),
      );
      const entry = {};
      FIELDS.forEach((f, i) => { entry[f] = values[i]; });
      return [key, entry];
    }));
    const expired = entries.filter(([, entry]) => {
      const expiry = tankEntryExpiry(entry);
      return expiry > 0 && expiry <= now;
    });
    // Service-account deletion is authoritative and does not depend on a customer/admin opening the app.
    await Promise.all(expired.map(([key]) => dbDelete(`showcase/${encodeURIComponent(key)}`)));
    res.status(200).json({ ok: true, removed: expired.length });
  } catch (error) {
    console.error('cron-tank-cleanup', error?.message || error);
    res.status(500).json({ error: 'cleanup-failed' });
  }
}
