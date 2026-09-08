# Staying inside the free Realtime Database allowance

The store runs on Firebase's **Spark** plan: 1 GB stored, **10 GB downloaded per billing
cycle**, 100 simultaneous connections. Storage has never been near its limit. Downloads are the
one that can take the shop offline — exhaust them and the database stops serving until the cycle
resets, which means no products, no orders and no sign-in, for up to a month.

On 7 Sep 2026 the store was running at **1.2 GB/day** and would have hit the cap on about the
9th, with the cycle not resetting until 1 Oct. This is what it was, what fixed it, and what has
to be done to keep it fixed.

## What went wrong

Images were stored as base64 **inside** the database, under `media/`. That node was 20.2 MB of a
20.5 MB database — `products` was 68 KB by comparison. And `hydrateMedia()` in `app.jsx` loads
**every** gallery image and guide poster on boot, not just the ones on screen, so a first-time
visitor pulled most of that node whatever page they landed on. Roughly sixty fresh visitors a
day was enough.

Nothing was broken. It was ordinary traffic against a payload that should never have been in a
database.

Firebase Storage is the natural home for these and is **not available** — enabling it now
requires the Blaze plan. So the files live in `assets/media/` and Cloudflare serves them, which
costs nothing, answers from a CDN, and already carries a one-year immutable cache header for
`/assets/*` (see `scripts/build-cloudflare.mjs`).

## How reads resolve now

`loadImg()` and `loadMediaItem()` are the only two functions that read an image. Both try, in
order:

1. the IndexedDB cache — so the app still works offline;
2. `assets/media/<key>.jpg`, **if the key is in `CDN_MEDIA_KEYS`** — costs the database nothing;
3. `media/<key>` in the database — the original path.

**The database copies were never deleted.** This is a change to what is *read*. No image can be
lost by it, and any key not in the list resolves exactly as it always did.

## The routine that keeps it working — do this after adding photos

A photo uploaded through Admin goes into the database as base64, because Storage is unavailable.
It is not in `CDN_MEDIA_KEYS`, so every visitor downloads it from the database. A handful is
harmless; a few dozen rebuilds the problem. **Roughly monthly, or after adding several
products or guides:**

1. Firebase Console → Realtime Database → `media` → ⋮ → **Export JSON**
2. Decode and shrink the new images (macOS; `sips` is built in, nothing to install):

   ```bash
   cd ~/Downloads && python3 - <<'PY'
   import json, base64, os, glob
   src = sorted(glob.glob("*media-export*.json"), key=os.path.getmtime)[-1]
   out = os.path.expanduser("~/Downloads/media"); os.makedirs(out, exist_ok=True)
   d = json.load(open(src)); n = 0
   for k, v in d.items():
       if not isinstance(v, str) or not v.startswith("data:") or "video" in v[:40]: continue
       ext = "png" if "png" in v[:40] else "webp" if "webp" in v[:40] else "jpg"
       open(os.path.join(out, f"{k}.{ext}"), "wb").write(base64.b64decode(v.partition(",")[2]))
       n += 1
   print(f"wrote {n} images to {out}")
   PY
   cd ~/Downloads/media && for f in *; do
     base="${f%.*}"
     case "$base" in *_thumb) max=320;; *) max=1000;; esac
     sips -s format jpeg -Z $max --setProperty formatOptions 60 "$f" --out "$base.jpg" >/dev/null 2>&1
     [ "$f" != "$base.jpg" ] && rm -f "$f"
   done
   ```

3. Upload the folder to `assets/media/` on GitHub (Add file → Upload files, commit to `main`)
4. `node scripts/sync-media-list.mjs`, then rebuild and deploy

Step 4 is not optional and is not a formality: `test/cdn-media.test.mjs` fails the build if the
list and the directory disagree, in either direction. A listed key with no file renders broken;
a file nobody lists is a database read that did not need to happen.

## Customer tank photos

These are the one image customers can write themselves, so they cannot be migrated by hand —
which is why they are bounded instead:

- **one** photo per entry (`MAX_IMGS`), stored once. It used to be three, with `imgData`
  duplicating the first, so sharing three pictures stored four.
- **200,000 characters** (~150 KB), down from 650,000. The old budget was set against what the
  rules would accept rather than what the gallery draws, which is a card a few hundred pixels
  wide.
- **deleted after 24 hours** by `api/cron-tank-cleanup.js`, a service-account sweep that does not
  depend on anyone opening the app.
- the rules cap each image at 260,000 characters and `imgs` at one element, so a client that
  ignores the app cannot write megabytes into a node every visitor reads.

Two traps found here, both worth remembering:

**An OFF switch has to stop the READ.** `showcaseEnabled` was honoured in exactly one place —
`TankShowcaseSection` returning `null` — so switching the showcase off hid the gallery while the
boot listener went on downloading every photo. A hidden feature was costing full price.

**Do not read a node to inspect a timestamp.** `cron-tank-cleanup` called `dbGet('showcase')`
every fifteen minutes — ninety-six times a day — to check five expiry fields, pulling every
customer's photo each time. It now lists keys with `dbGetShallow()` and reads only the scalars.
Service-account bytes are billed exactly like a customer's.

## The second cause: the shop pages read the whole media node

Moving the images to the CDN fixed the browser. It did not fix the server, and the daily figure
stayed high for a day longer than it should have.

`/p` and `/p/<slug>` — the search-indexable pages — called `fetch(DB/media.json)` on every
request, the entire 20 MB node, to pick out a handful of image keys. The route set
`Cache-Control: public, s-maxage=600`, so it read as a page cached at the edge for ten minutes.
It never was. **A Worker that returns a Response it built itself does not populate Cloudflare's
cache** — only responses that came back through `fetch` do — so the header advised a cache that
was never consulted, and every crawler hit paid for all 20 MB. Sixty hits a day is 1.2 GB.

Two lessons worth keeping:

- A `Cache-Control` header on a Worker-rendered response is a claim, not a mechanism. If you
  want a Worker response cached, use the Cache API explicitly, or check the `cf-cache-status`
  header before believing it.
- Fixing the client is not fixing the system. The same images were being read twice over, by two
  different code paths, and only one of them was in `app.jsx`.

Those pages now build URLs instead of loading bytes — the CDN copy where `assets/media/` has the
file, otherwise `/share-image/<key>`, which reads one key and is genuinely edge-cached because it
goes through `fetch`. Rendering a shop page costs the database nothing. It also repaired the
share previews: `og:image` used to be a base64 data URL for anything still in the database, and no
social crawler can fetch one of those.

## Storage, which is a different number

Downloads are the dangerous one. Storage is not close:

| | used | allowance |
|---|---|---|
| Downloads | ~9.8 GB per cycle before the fixes | 10 GB |
| Storage | 20.8 MB | 1 GB |

Of that 20.8 MB, **`media` is 20.2 MB** — 97%. Everything else in the database together is about
600 KB. So any storage work that is not about `media` is rounding error, and a new photo costs
roughly 250 KB (a 1100px JPEG, base64, which adds a third). At that rate storage has room for
thousands more pictures. It is not the constraint; downloads are.

The 83 images that now have a file in `assets/media/` no longer need their database copy — every
reader consults the CDN first. **Admin → Settings → Free Database Space** clears exactly those and
nothing else, which takes the database from 20.8 MB to under 1 MB. It walks `CDN_MEDIA_KEYS`, so
it cannot touch an image that has nowhere else to come from, and it reads nothing, so pressing it
twice is free.

Nodes that grow forever, all tiny today, none worth acting on yet:

| node | grows by | note |
|---|---|---|
| `analytics/search/<term>` | one key per distinct search word | the only one a visitor can grow without limit; each key is a single number |
| `analytics/daily/<date>`, `analytics/events/…` | one key per day | |
| `paymentWebhookEvents/<id>` | one record per payment event, ~150 bytes | the dedupe ledger; never pruned |
| `orders`, `tankMonthlyEntries`, `totmVotes/<month>` | with the business | real records — Admin already has an order cleanup |

## When something looks wrong

Realtime Database → **Usage** shows downloads for the current cycle against the allowance. Check
it monthly. If the daily figure climbs above ~100 MB, something is reading images from the
database again — find it before assuming, by exporting a node and measuring it:

```bash
python3 -c "import json,sys;d=json.load(open('export.json'));\
print('\n'.join(f'{len(json.dumps(v))/1048576:8.2f} MB  {k}' for k,v in \
sorted(d.items(), key=lambda kv:-len(json.dumps(kv[1])))))"
```

That one command is what turned a guess into a diagnosis: `products` 68 KB, `media` 20.2 MB.
Two earlier hypotheses — the tank showcase, then the analytics node — were both wrong, and
measuring is what settled it.
