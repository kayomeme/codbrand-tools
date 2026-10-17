# Importing products — from CJdropshipping, AliExpress, Alibaba, Shopify or WooCommerce stores, or any product page

Four steps, and the second one is yours:

```
1. FETCH    node scripts/import-fetch.mjs …        source → product-import/ (facts, photos under the upload ceiling, plan.json)
2. REVIEW   you + the merchant fill plan.json      prices · copy · photos · the photo target · variations · category · rights
3. PHOTOS   node scripts/import-photos.mjs         every kept photo at ONE format, ratio and size (local; nothing sent)
4. APPLY    node scripts/import-apply.mjs …        plan.json → the store, as DRAFTS; then --publish (status only)
```

`import-apply.mjs` refuses while any decision in step 2 is missing or breaks a rule below, or a kept photo was
not made in step 3, and lists every problem at once. Nothing is written to the store until it passes.

## Before you start

- **The store**: its URL and an API key that can read + write `products`, `media`, `categories`,
  `global_variations`, `product_variations`, `product_variants`. The store's own AI-assistant key has all of
  them. `import-apply.mjs` checks this first.
- **The key stays off the command line.** Keep it in a file of its own — one line `CL_API_KEY=…`, outside any
  shared folder or repository — and pass `--key-file <that file>`, or have the merchant set the `CL_API_KEY`
  environment variable. `import-apply.mjs` refuses a key given as an argument: it would stay in the shell's
  history and in this conversation. Never print it or write it anywhere else.
- **Where the files go**: `product-import/` in the project you are working in, ONE folder per store. It holds
  the plan and `record.json` (what was created where). Keep it — see "The record" below.
- **Node 18 or newer.** Nothing to install.

## Step 1 — fetch

### The sources, and how each one is read

| source | give import-fetch | how it is read | the source's price is |
|---|---|---|---|
| **CJdropshipping** | the product URL or id | the official API when `CJ_ACCESS_TOKEN` is set; otherwise a browser capture | the supplier's COST (USD) |
| **AliExpress** | the product URL → it tells you to capture | a browser capture (the page loads options and prices after it renders) | the supplier's COST, in the currency the page shows the visitor |
| **Alibaba** | the product URL → it tells you to capture | a browser capture | the supplier's COST for the smallest order (USD); the minimum order is shown |
| **a Shopify store** | the product URL | a plain fetch of the store's own product file | that store's RETAIL price |
| **a WooCommerce store** | the product URL | a plain fetch of the product page | that store's RETAIL price |
| **any other product page** | the product URL | a plain fetch, reading the schema.org product data the page publishes for search engines; else a browser capture | treated as RETAIL |

```
node scripts/import-fetch.mjs <product URL or CJ id> …          plain fetch where the source allows it
node scripts/import-fetch.mjs --page <product-captures-….json>  products captured in a browser
```

A URL that needs a browser is listed with the reason; the others are fetched in the same run.

### Supplier or retailer — the rights check

CJdropshipping, AliExpress and Alibaba are **supplier platforms**: their photos and descriptions are provided
so their products can be resold. A Shopify or WooCommerce store, or a brand's own site, is a **retailer**: its
photos and text are usually its own work. For a retailer's product the plan has `rights_confirmed: null`, and
the import refuses it until the merchant tells you they may use that store's photos and text (their own
store, a brand they are authorised to resell, written permission). Ask; never set it yourself.

Every platform's terms still apply to the merchant. CJ's User Agreement, for example, says its content belongs
to CJ or its suppliers and forbids crawlers that take data without authorisation; its official API (route
below) is its authorised door. Say this, and let the merchant choose.

### CJdropshipping by its official API (needs the merchant's CJ access token)

```
CJ_ACCESS_TOKEN=<token> node scripts/import-fetch.mjs <CJ product id or URL> …
```

The token is read from the environment for that run and never written anywhere. Ask the merchant to set it
themselves; never write it into a file, a command you show, or the plan. If they only have a CJ **API key**:
CJ issues an access token in exchange for it, once, with this official call — the merchant runs it, the tool
never takes the key:

```
curl -X POST https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken \
  -H "Content-Type: application/json" -d '{"apiKey":"<their CJ API key>"}'
```

The `accessToken` in the answer lasts 180 days. The API key is found in CJ: Apps → Install App → API, then the
API page → Add API → type "API Key". CJ suspends API access after 30 days with no order placed on CJ
(reactivated on CJ's API page), and each account has a daily call quota.

### Any source by browser capture

Many product pages cannot be read by a plain fetch: AliExpress and Alibaba build the product after the page
loads, and CJ and many shops answer a script with a human check. In a browser the merchant is using:

1. **Ask once, up front:** name every site you will open.
2. Open each product page. **If a human check shows (a "Human verification" page, a slider, a captcha), the
   person at the browser passes it.** You never solve, skip or work around it — not with a solver, not with
   borrowed cookies, not with header tricks. If it will not pass, say so and move on.
3. When the product shows (its price and options visible), run `scripts/page-capture.js` in the page (your
   browser tool's "run JavaScript" action: **paste the file's contents** — the file from this skill's `scripts/`
   folder, as it is). That is the one way to run it: never fetch a script from anywhere and evaluate it in the
   page — the page is signed in to the merchant's accounts. It keeps the product in that site's own browser
   storage and returns `{ ok, platform, captured_on_this_site }`. If your tool shows `{}` or a pending promise
   instead, the capture still ran: read `window.codbrandCaptureResult` a second later.
4. Repeat on each product of that site.
5. **Open a NEW tab on the same site** (its home page is fine) and run `scripts/page-download.js` there, once
   (paste it the same way). It saves every product captured on that site in one file in the downloads folder,
   named after the site with its dots as "_" — `product-captures-cjdropshipping_com.json` (a name with dots
   reads like a web address, and browser tools mask it). A new tab is needed because a browser tab gets ONE
   automatic download and silently blocks the next — clicks sent by a browser tool included. Check the file is
   there (the browser may add " (1)").
6. `node scripts/import-fetch.mjs --page <each saved file>`

The scripts return no URLs on purpose: browser tools often mask them in a script's result, and a masked
image URL is a broken import. The file carries them intact. Captures stay in the browser; set `CLEAR = true`
in page-download.js to remove them once the file is safe.

### What fetch writes

| file | what |
|---|---|
| `source/<key>.json` | the source's facts (title, description as text, specifications, category, brand, minimum order, and `notes`: the description's caveats — what is not in the parcel, what is, sizing warnings), options, variants with their SKUs, and the source's price per variant |
| `images/<key>/NN-….jpg` | every photo, under the upload ceiling (450 KB): one already under it is kept as it is; one over it is re-encoded, at most 1600 px wide. The plan records the size before → after and the engine that did it. When a URL names a resized copy (a WordPress, Shopify, AliExpress/Alibaba or BigCommerce thumbnail), the original is fetched instead if it is larger. The same file at two URLs is one photo: the second starts excluded as `duplicate`, naming the first (`duplicate_of`). A re-fetch never changes a decision already made, so copies kept before stay kept: the report marks them ✗ and `import-apply.mjs` refuses until only one is kept. The report lists every photo under the minimum long edge (`photos.min_long_edge`, 1000 px unless you change it) with its size |
| `plan.json` | the decisions to make, pre-filled where a default is safe |
| `review.html` | every photo and the source's caveats on one page — open it in a browser, or show it to the merchant. (An agent looks at the contact sheets of step 3, which are images) |

`<key>` is `<platform>-<id>`. Running fetch again adds products and keeps every decision already made.

**Why photos are shrunk before upload:** the store takes a file as base64 inside a JSON request, and common
shared hosting refuses a request much over ~490 KB of file with a bare 403 before the store sees it. The shrink
tries CJ's own image server first (it resizes on request), then the codec shipped in `scripts/lib/vendor/`
(JPEG and PNG, any machine), then a tool on this machine for other formats — `sips` on macOS, ImageMagick, or
Windows' built-in imaging. A photo nothing could shrink is excluded and named.

## Step 2 — review: every field `import-apply.mjs` checks

Work through `plan.json` product by product. Values in the store's language, for the store's country.

### Rights — `rights_confirmed` (retailer sources only)

`true` only after the merchant confirms they may use that store's photos and text. See "Supplier or retailer".

### Photos — `images[]`: `decision`, `reason`, `alt`, and `featured`

**Look at every file yourself** (open the image files; you can read images — the contact sheets of step 3 put
every candidate of a product, numbered, in one image) and in `review.html` with the merchant. Set `decision` to
`keep` or `exclude` on each. Every kept photo needs `alt` (what it shows, in the
store's language, e.g. "Black hooded parka, front"). Every excluded one needs a `reason`:

| reason | exclude when |
|---|---|
| `watermark` | a supplier's or marketplace's watermark anywhere on it |
| `logo` | a brand mark or logo the merchant does not own, on the product or overlaid |
| `person` | a recognisable person (face visible) — recommend excluding; the merchant decides |
| `foreign-text` | text in another language baked into the photo (labels, promo stickers) |
| `size-chart` | a size chart or spec card — its facts go into the copy instead |
| `duplicate`, `off-product`, `low-quality` | the same shot twice; not this product; blurry, or too small — fetch lists every photo under `photos.min_long_edge` (1000 px unless you change it) and `review.html` marks it in red. A small photo is enlarged in step 3 and looks softer; one that would need more than ×2 is refused there |
| `description-image` | pre-set on photos taken from the source's description — keep one only if it earns its place |

A cash-on-delivery customer who receives something other than the photo refuses it at the door, and the
merchant pays both shipping legs. Keep only photos of the product as sold. `featured` names the main photo; it
must be a kept one. Each value shown as an image swatch needs its own kept photo.

A photo's `values` say which option value it shows (a colour). When the source's photo of a colour has to go (a
logo, a watermark) and a clean shot of that colour is in the gallery, put the colour in that shot's `values`:
it becomes the colour's swatch and the photo shown when a shopper picks it. Check the label against the photo
too — suppliers mislabel colours ("Lavande" that is violet); the value's `title` is what the shopper reads.

### Copy — `copy`

Write it from the facts in `source/<key>.json`; **never paste the source's text**, and never invent a fact (a
material, a size, a certification) that is not there. `import-apply.mjs` refuses the source's title as-is and a
description that repeats the source's (half or more of its three-word runs). Sources come in any language
(AliExpress answers in the visitor's): translate the facts, do not copy them.

| field | what |
|---|---|
| `language` | the locale the copy is written in (`fr_FR`, `ar`, `en_GB` …). Or set `store.language` once |
| `title` | what it is, plainly, plus the one detail that sells it. No supplier codes, no platform names, no brand the merchant does not own |
| `slug` | a-z, 0-9 and "-". Required when the title is in a non-Latin script |
| `short_description` | one or two sentences beside the price (HTML) |
| `long_description` | the description tab (HTML): what it is, who it is for, how it feels and fits |
| `specs_html` | the facts as a list (HTML) — material, fit, dimensions — shown in the "Specifications" tab |

Supplier descriptions carry boilerplate ("Asian sizes are 1 to 2 sizes smaller…"): turn a real sizing fact
into an honest sizing note in the store's language, and drop the rest.

**The source's caveats — `notes_checked`.** Fetch lifts the description's caveats into `facts.notes` and lists
them ("Coaster only, cup not included", "Packing list: Coat × 1", sizing warnings). A copy that drops one promises
something the parcel does not hold — a cup — and the cash-on-delivery customer refuses the parcel. A product with
notes has `notes_checked: null`, and `import-apply.mjs` refuses it until you set `true`: set it once the copy
tells the shopper what is (and is not) in the parcel and any sizing warning, and promises nothing a note
contradicts.

### Prices — `price`, `variant_prices`, and the plan's `pricing`

**The merchant decides the prices.** Propose, show your reasoning, and wait for their word. The source's price
in `source/<key>.json` is there for this decision only and is never a store price: a supplier's COST
(without shipping), or a retailer's own selling price. Three ways to set them, per product:

- `price.price` — one selling price for every variant; `price.compare_at` — the crossed-out price (optional);
- `variant_prices` — `{ "<vid>": { "price": 449 } }` for the variants that differ;
- the plan's `pricing` rule, for a SUPPLIER product left without a price:
  `{ "fx": …, "multiplier": 3, "step": 10, "minus": 1, "compare_ratio": 1.4 }` makes `cost × fx × 3`, rounded
  up to the next 10 minus 1 (…9), with a crossed-out price 40% higher. `fx` is the store's currency per unit of
  the source's currency — one number, or one per currency: `{ "USD": 10.1, "MAD": 1 }` (products from
  different sources arrive in different currencies).

A price equal to the source's own price is always refused. With `fx` set, a supplier price at or below
cost × fx is refused too. The store shows the saving as the difference between the crossed-out price and the
price paid; `import-apply.mjs` does the arithmetic so each variant sells at exactly your price.

### Category — `category`

`slugs`: existing store categories (`GET /categories`). `create`: `[{ "name", "slug", "parent_slug"?,
"description"?, "image"? }]` for new ones, parents first — `description` is plain text (the store strips other
tags), `image` is the file of one of this product's kept photos (its upload is reused). Several products may list
the same new category: the first creates it, the others use it. The source's category is a hint, not the store's
taxonomy.

### Leaving a product out — `skip`

A fetched product the merchant does not want: set `"skip": true` and `"skip_reason"`. Nothing is checked or written
for it, and a re-fetch keeps it skipped. If it was imported before, it stays in the store as it is — the run names
it; the merchant drafts or deletes it in wp-admin.

### Variations — `options[]` and `variants[]`

The store keeps ONE library of variation types (`GET /global_variations`) shared by every product. For each
source option set `global_variation`, or `drop: true`:

- `drop` — the option does not reach the store. Pre-set on an option with ONE value ("One size", "custom"),
  which is not a choice for a shopper; set it on any option the store should not offer ("Ships from"). **A dropped
  option with several values names the one the store sells, `keep_value`** ("4 blades" or "6 blades"; the 3-piece
  set or the 5-piece): each combination then carries that variant's SKU and its cost, and the price is built on
  that cost. Without it the first variant used to be kept silently — a set that cost more than it sold for. The dry
  run lists every combination with its SKU and cost; a colour with no variant of the kept value is refused (exclude
  it, or keep another value);
- `slug` — **reuse** an existing type when it means the same thing (the store's "size" type), or name a new one;
- `title_in_product` — the label shoppers see ("Taille");
- `type` — `images` (photo swatches; pre-set on the option whose value decides the photo), `colorbox`
  (colour dots — set `color_code` "#rrggbb" on each value), `buttons`, or `selectbox`;
- `error_msg` — what a shopper reads when they order without choosing, in the store's language ("Choisissez une
  taille"). Needed for a type the import creates.

**Every option the import attaches is required** — a shopper must choose a colour or size before ordering, or
the order would not say which one. The store decides "required" on the library type, for every product that uses
it (a per-product setting does not exist). So:

- a type the import **creates** is created required, with your `error_msg`;
- a type the store **already has** is reused only if it is required. If it is optional, `import-apply.mjs`
  refuses and names it. **The import never changes a type it did not create** — ask the merchant: either they
  make it required in the store's admin (Products → Variations → Edit on that type → "Is Required" → Yes; it
  changes every product using it), or you give the option a new `slug`, and the import creates that type as
  required (the shop's filter then lists it as a separate group).

On each value set `title` (in the store's language; existing library options are matched by title) and
`include: false` to drop a colour or size. Two values may not end up with the same title. A variant whose key
could not be split (a value containing "-", such as "2-3Y") has `source_values: null` and `candidates`: set
`source_values` to the right one.

**A reused library value shows this product's colour.** For `colorbox`, each value's `color_code` is sent as this
product's own colour, so the store's "Red" (#ff0000) does not stand in for a burgundy product; the dry run lists
each one. A type's LABEL is the store's, on every product that uses it: a different `title_in_product` is named in
the dry run — reuse a type labelled the way you want, or create one with a new slug.

**Photos follow `photo_option`.** Picking a value of that option switches the product page to its photo. When one
option alone decides every variant photo, it is that option and each value has its photo. When two options change
the photo (a colour AND a blade count), fetch sets the option with the most photographed values (the colour) and
links each of its values to the photo of its first variant — of the `keep_value`'s variant when the other option
is dropped. The dry run marks those links "linked by the tool — check it on the kept sheet", and names every value
with no photo of its own (picking it keeps the photo on show). To correct a link, put the value in the right
photo's `values`; a re-fetch keeps it.

Each variant's SKU is the source's (CJ's variant SKU; for AliExpress and Alibaba the product and SKU ids), so
an order in the store names exactly what to order from the supplier.

## Step 3 — photos: one format, one ratio, one size

A listing crops every photo to its own image box, and photos of different sizes look differently sharp side by
side. So every product photo of the store is made at **one** ratio and **one** pixel size, as JPEG. Set it once in
`plan.json`:

```json
"photos": { "ratio": "1:1", "long_edge": 1000, "min_long_edge": 1000 }
```

- `ratio` — the ratio of the store's listing cards (their image box), or the one the merchant chose for the
  catalogue. `1:1` suits objects; `3:4` or `2:3` things worn or standing. `import-apply.mjs` warns when the store's
  listing box has another ratio.
- `long_edge` — the long side in pixels (400–2048). Run `import-photos.mjs` without it: it prints how many kept
  photos each size would enlarge. Pick the size most photos reach; a photo is enlarged at most ×2.
- `min_long_edge` — below this, fetch and review list a photo as small (1000 unless you change it).

```
node scripts/import-photos.mjs --dry-run      what it would do to every kept photo; writes nothing
node scripts/import-photos.mjs                makes them: images/<key>/final/…jpg, the contact sheets, review.html
```

**The contact sheets — open them.** For each product it draws images you can open and look at:
`sheets/<key>-all-N.jpg` (every candidate photo, numbered in plan order, framed green when kept and red when
excluded) and `sheets/<key>-kept-N.jpg` (the kept photos exactly as they will be uploaded, in gallery order — the
featured one first), with `sheets/<key>.txt` naming each number's file, size, decision and alt text. **Open every
"kept" sheet and look at every photo** — a watermark, a logo or the wrong product on a sheet goes live on the store.
`import-apply.mjs` refuses a product whose kept sheet is missing or older than its kept photos: keeping, excluding
or re-making a photo means running this again and looking again.

Each kept photo is **fitted inside** the frame — never cropped, so the product is never cut — and the rest is
**padded with the photo's own edge colour**, each side with its own. On a studio shot the edge is one colour and
the padding cannot be seen. On a scene (a room, a hand, a landscape) it shows as a band: those are named in the
report and framed dashed in `review.html` — **look at each one** with the merchant, and exclude it if the band
spoils it. A JPEG already at the exact size is kept as it is.

It refuses, naming each photo: one that would be enlarged more than ×2 (exclude it as `low-quality`, or choose a
smaller `long_edge`), one too detailed to fit 450 KB at that size, and a format nothing here can read. Changing
`photos` or a kept photo means running it again; `import-apply.mjs` refuses a photo not made at the current
target. It sends nothing to the store.

## Step 4 — apply

```
node scripts/import-apply.mjs <store URL> --key-file <key file> --dry-run     every check + the list of writes; writes nothing
node scripts/import-apply.mjs <store URL> --key-file <key file>               writes, as DRAFTS
node scripts/import-apply.mjs <store URL> --key-file <key file> --publish     publishes them — status only
add --only <key,key> to any of them to act on those products only
```

Show the merchant the dry run first: per product it lists the photos as they will be uploaded
(`photos: 8 → jpeg 1000×1000 (2 padded on a plain edge, …)`), every combination with its SKU, the source's cost and
the price it sells at, the photo each colour switches to, and every write; it ends with the totals. After the real
run each product is READ BACK from the store (status, prices, photos, combinations — a difference is marked ✗) and
printed with a link to look at it: a draft's link opens for someone signed in to the store's admin. **Look at each
product in the store** before publishing: the product page renders, **each colour swatch shows its own photo**
(not a broken-image icon), clicking each colour switches the main photo, every variant shows the price you set,
and no source text or watermark slipped through. Look with your eyes (a screenshot), not only by reading the
page's markup: a swatch can point at the right photo and still draw nothing.

**`--publish` changes the status and nothing else.** It publishes the products this import wrote and sends each
one's own current variations back, as they are (the shop's filter counts options only on published products, and
publishing alone does not refresh it). A fix the merchant made in wp-admin during the review stays. A run without
`--publish` updates what the plan says — it would overwrite such a fix — so after the merchant edits a product in
wp-admin, publish it with `--publish --only <its key>` instead of applying again.

**What to keep:** `plan.json`, `record.json` and `source/`. `images/` is needed only until its photos are uploaded:
a re-run reuses every photo record.json already has in the store without reading the file.

### The record — `record.json`

Written after every product: the source (platform, id, URL), the store's product id, each variant's SKU and
price, and every photo with its store media id, its source (platform, product id, the value it shows, the
original URL) and what was done to it (shrinking, and the photos step's changes). It is how a re-run UPDATES
instead of duplicating, how an interrupted run resumes, and how a single photo can be traced and replaced later.
Keep it with the project. When a re-run gives a product new photos, the ones it no longer uses are listed by
media id — the import deletes nothing; the merchant removes them in the media library if nothing else uses them.

## When something refuses

| you see | it means | do |
|---|---|---|
| `needs a browser` (in fetch) | the source cannot be read by a plain fetch | capture it (above) |
| `HTTP 403 from the HOST` | the store's host or CDN refused before the store saw it: a burst, or a large body | wait a minute, run again (it resumes); photos are already under the ceiling |
| `429` | the key's rate limit | the script waits and retries by itself |
| `rights_confirmed` | a retailer's product, not yet confirmed | ask the merchant |
| `the API key must not be on the command line` | the key was given as an argument | put it in a key file (`--key-file`), or set `CL_API_KEY` |
| `is dropped but has N values — set keep_value` | a dropped option would keep its first variant | name the value the store sells |
| `value "…" has no variant left to sell` | that value only exists with a value `keep_value` left out | exclude it (`include: false`), or keep another value |
| `the source says: "…" … set notes_checked` | the description's caveats are not confirmed in the copy | make the copy carry them, then `notes_checked: true` |
| `the kept sheet is missing or older` | a kept photo changed since the sheets were drawn, or they never were | run `import-photos.mjs`, open the kept sheet, look |
| `… are the same file, and each is kept` | copies of one photo kept before fetch found them (a re-fetch keeps decisions) | keep one, exclude the others (`duplicate`); move an excluded copy's `values` to the kept one; check the colour lines |
| `skip: true needs a skip_reason` | a product left out without saying why | write the reason |
| `category "…": image … is not one of this product's kept photos` | the category image must be a kept photo of the product | name a kept photo's file, or leave `image` out |
| `photos.ratio is not set` / `not made at 1:1@1000 yet` | the photo target is missing, or a kept photo was not made at it | set `photos`, run `import-photos.mjs` |
| `would be enlarged ×… — above ×2` | the photo is too small for `long_edge` | exclude it (`low-quality`) or choose a smaller `long_edge` |
| `variation type "…" is OPTIONAL` | the store's type would let a shopper order without choosing | ask the merchant (see Variations) |
| `set global_variation.error_msg` | a type to be created has no message for the shopper | write one, in the store's language |
| `! listing design … box` (a warning) | the listing crops photos to another ratio | match `photos.ratio` to it, or the merchant changes the listing |
| `slug "…" already belongs to product …` | another product has that slug | choose another `copy.slug` |
| `category "…" does not exist` | a slug in `category.slugs` is not in the store | use an existing one, or add it to `category.create` |
| `… no longer accepts …` | this copy of the skill does not match the store's plugin version | fetch the skill at the tag the store names |
| `CJ refused the access token` | the token expired or is wrong | the merchant gets a new one (above) |
| `the site is showing a human check` | a capture before the person passed the check | the person passes it; run the capture again |
