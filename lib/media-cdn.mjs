/**
 * Which media keys have a file on the CDN, and what URL to hand a crawler for one that doesn't.
 *
 * `app.jsx` carries its own copy of this list (same markers, same generator) because it is
 * transformed rather than bundled and cannot import. Both are written by
 * `node scripts/sync-media-list.mjs`, and test/cdn-media.test.mjs fails the build if either
 * drifts from assets/media/.
 *
 * The browser wants the bytes and resolves cache -> CDN -> database. The server-rendered /p
 * pages want none of the bytes: they only ever put an image in an <img src> or og:image, so a
 * URL is the whole job. That distinction is the point of this module.
 */

export const CDN_MEDIA_KEYS = [
  /* __MEDIA_LIST_START__ */
  "img-g17804637572063k4",
  "img-g1780498054125i31",
  "img-g1780498139717lsd",
  "img-g1780498161277jir",
  "img-g1780498239996cc7",
  "img-g1780498257941ikm",
  "img-g1780498278949eww",
  "img-g1780498299252gof",
  "img-g1780498317149sl5",
  "img-g1780498333789w68",
  "img-g1780498348692okm",
  "img-g1788185588002qz1",
  "img-g17881857092392ar",
  "img-g17881857709437oq",
  "mi1782669747153p8f_thumb",
  "mi1785437407665w1f",
  "mi1785437407665w1f_thumb",
  "mi1785520525426gp6",
  "mi1785520525426gp6_thumb",
  "mi1785520633718nn4",
  "mi1785520633718nn4_thumb",
  "mi1785520915527lpu",
  "mi1785520915527lpu_thumb",
  "mi1785521384020bqe",
  "mi1785521384020bqe_thumb",
  "mi1785521694044hmi",
  "mi1785521694044hmi_thumb",
  "mi1785785662134gho",
  "mi1785785662134gho_thumb",
  "mi17857860124057pw",
  "mi17857860124057pw_thumb",
  "mi17857863637152e0",
  "mi17857863637152e0_thumb",
  "mi17857866454577gr",
  "mi17857866454577gr_thumb",
  "mi1785786888314wd0",
  "mi1785786888314wd0_thumb",
  "mi1785787187927sg5",
  "mi1785787187927sg5_thumb",
  "mi1785787505410x19",
  "mi1785787505410x19_thumb",
  "mi1785787840446hko",
  "mi1785787840446hko_thumb",
  "mi1785788029028web",
  "mi1785788029028web_thumb",
  "mi1785788532205x9l",
  "mi1785788532205x9l_thumb",
  "mi1785789014218f4m",
  "mi1785789014218f4m_thumb",
  "mi1785789408241iox",
  "mi1785789408241iox_thumb",
  "mi1785789747760ci1",
  "mi1785789747760ci1_thumb",
  "mi1785790151470l69",
  "mi1785790151470l69_thumb",
  "mi1785790707242p6f",
  "mi1785790707242p6f_thumb",
  "mi1785791588330vb5",
  "mi1785791588330vb5_thumb",
  "mi17857918202123ea",
  "mi17857918202123ea_thumb",
  "mi1785792076080ps7",
  "mi1785792076080ps7_thumb",
  "mi178585425077208n",
  "mi178585425077208n_thumb",
  "mi1785854397118lss",
  "mi1785854397118lss_thumb",
  "mi1785854625808ybw",
  "mi1785854625808ybw_thumb",
  "mi1785855002787oxy",
  "mi1785855002787oxy_thumb",
  "mi1785855352578wpj",
  "mi1785855352578wpj_thumb",
  "mi1785855664317ijp",
  "mi1785855664317ijp_thumb",
  "mi1785856954946ju3",
  "mi1785856954962qoe",
  "mi1785856954962qoe_thumb",
  "mi1785857266393gux",
  "mi178585726642765t",
  "mi178585726642765t_thumb",
  "mi17858577201895it",
  "mi17858577201895it_thumb",
  /* __MEDIA_LIST_END__ */
];

const ON_CDN = new Set(CDN_MEDIA_KEYS);

/** Media keys are used to build URLs and DB paths, so keep them to the shape the app writes. */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,96}$/;

/** The path under the site root, or null when the key has no file on the CDN. */
export function cdnMediaPath(key) {
  return key && SAFE_KEY.test(key) && ON_CDN.has(key) ? `assets/media/${key}.jpg` : null;
}

/** An absolute URL to the CDN copy, or '' — the caller decides what to do without one. */
export function cdnMediaUrl(key, base) {
  const path = cdnMediaPath(key);
  return path ? `${base}/${path}` : '';
}

/**
 * The Worker route that reads one key out of the database and serves it as an image, cached at
 * the edge for an hour. Costs the render nothing; costs the database one key, at most hourly.
 */
export function dbMediaUrl(key, base) {
  return key && SAFE_KEY.test(key) ? `${base}/share-image/${encodeURIComponent(key)}` : '';
}

/** The best URL for a key we already know exists: the CDN copy, else the database route. */
export function mediaUrlFor(key, base) {
  return cdnMediaUrl(key, base) || dbMediaUrl(key, base);
}
