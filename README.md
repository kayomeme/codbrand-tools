# codbrand-tools — references & scripts

Everything the `codbrand-tools` skill uses, except its entry point. The skill is a toolbox for stores
running the COD Leads plugin. Its first tool imports products into the store — from CJdropshipping,
AliExpress, Alibaba, a Shopify or WooCommerce store, or any product page. Facts, photos, variants and
category go in as drafts, with the merchant's own prices and copy rewritten for the store's language and
country.

## This is most of a skill, but not its entry point

`SKILL.md` — the skill's instructions — **ships inside the COD Leads plugin** and is installed from
there. Everything `SKILL.md` refers to lives here:

| in this repository | ships with the plugin |
|---|---|
| `references/` — how each tool is used, step by step | `SKILL.md` — the tools and their rules |
| `scripts/` — `import-fetch.mjs`, `import-apply.mjs`, the browser scripts `page-capture.js` and `page-download.js`, and their `lib/` | |

The layout matches the installed skill exactly, so the contents of this repository drop straight into
a skill folder with no renaming and no merge step.

The scripts are deliberately **dependency-free** — they run on bare `node` (18 or newer), with no install
step. The one library they carry, a JPEG codec, is included in `scripts/lib/vendor/` with its licence.
`page-capture.js` and `page-download.js` run in a browser, on the pages they read.

## What the product import will not do

- publish a source's price, or a source's text as the store's copy — `import-apply.mjs` refuses both;
- use another store's photos and text without the merchant's confirmation that they may;
- upload a photo nobody reviewed, or one over the store's upload limit;
- store a credential, or get past a site's human check: a person passes it in their own browser.

## Use exactly the tag your store names

Each release is tagged `skill-YYYY-MM-DD.N` (for example `skill-2026-09-27.1`), and the `SKILL.md` a
store serves belongs to one of them. The store reports that tag as `version_tag` in `/cl-api/v1/me`
and `/cl-api/v1/skills`. Fetch exactly that tag, so the references and scripts you use always match
the instructions and the store you are working on. No tag is ever moved.

The default branch, or a newer release, may describe doors or behaviour this store does not have.
Following it produces calls that fail against it.
