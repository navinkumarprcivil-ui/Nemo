/**
 * /p/ and /p/<slug> — the search-indexable shop pages, rendered per request.
 *
 * These were static files under /p/, written by a generator someone had to
 * remember to run. `lib/catalog.mjs` explains why that had to go; this is the
 * route in front of it. `vercel.json` rewrites /p and /p/<slug> here.
 *
 * A slug that isn't in the live catalogue returns 404 with a short page that
 * sends the reader to the shop — a delisted product should leave the index, not
 * linger in it.
 */

import { loadCatalogue, productPage, catalogPage, notFoundPage, BASE } from '../lib/catalog.mjs';
import { cdnMediaUrl, dbMediaUrl, mediaUrlFor } from '../lib/media-cdn.mjs';

function mediaUrl(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return value.url || value.downloadURL || value.downloadUrl || '';
}

/**
 * Give every gallery item a URL a crawler can fetch.
 *
 * This used to read the whole `media` node to find a handful of keys — 20 MB of base64, on
 * every request. Worker-rendered responses are not stored in Cloudflare's cache, whatever
 * Cache-Control says, so "cached at the edge for ten minutes" was never true of this route and
 * each crawler hit paid for all of it. That one line was most of a 1.2 GB day against a 10 GB
 * month.
 *
 * None of those bytes were needed. The page only ever puts an image in an <img src> or an
 * og:image, so a URL is the whole job: the CDN copy where assets/media/ has one, otherwise the
 * /share-image/ route, which reads that single key and is edge-cached for an hour. The render
 * now costs the database nothing.
 *
 * It also repairs the share previews. og:image was a base64 data URL for anything still in the
 * database, and no social crawler can fetch one of those.
 */
export function hydrateCatalogueMedia(cat) {
  for (const p of cat.products || []) {
    let hasPhoto = false;
    const existing = Array.isArray(p.media) ? p.media : [];

    p.media = existing.map((m) => {
      if (!m || m.type === 'video') return m;

      const key = String(m.key || '').trim();
      const thumbKey = key ? `${key}_thumb` : '';
      // The product record listing the item is the evidence that it exists; a thumbnail is
      // only there when m.thumb says so, or when the CDN plainly has the file. Pointing at a
      // thumbnail that was never made would serve the share banner in its place.
      const full = mediaUrl(m.url) || mediaUrlFor(key, BASE);
      const thumb = mediaUrl(m.thumbUrl)
        || mediaUrl(m.url_thumb)
        || cdnMediaUrl(thumbKey, BASE)
        || (m.thumb ? dbMediaUrl(thumbKey, BASE) : '');

      if (full || thumb) hasPhoto = true;
      return {
        ...m,
        ...(full ? { url: full } : {}),
        ...(thumb ? { thumbUrl: thumb } : {}),
      };
    });

    if (!hasPhoto) {
      const legacy = mediaUrl(p.imageUrl) || (p.hasImg ? mediaUrlFor(`img-${p.id}`, BASE) : '');
      if (legacy) p.media = [{ type: 'image', url: legacy }, ...p.media];
    }
  }

  return cat;
}

export default async function handler(req, res) {
  const slug = String((req.query && req.query.slug) || '').trim();

  let cat = null;
  try {
    cat = await loadCatalogue();
    hydrateCatalogueMedia(cat);
  } catch (e) {
    // A slow or unreachable database must not make the shop look deleted. 503
    // with a short retry tells a crawler to come back rather than drop the URL.
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', '120');
    return res.status(503).send(notFoundPage());
  }

  // Crawlers re-fetch these often and the catalogue changes a few times a day,
  // so cache at the edge for ten minutes and serve the stale copy while it
  // refreshes. A re-priced product still corrects itself quickly.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=86400');

  if (!slug) return res.status(200).send(catalogPage(cat));

  const product = cat.bySlug[slug];
  if (!product) {
    res.setHeader('Cache-Control', 'public, s-maxage=300');
    return res.status(404).send(notFoundPage(cat.STORE));
  }

  return res.status(200).send(productPage(product, cat));
}
