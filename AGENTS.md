# Brief for anyone (human or AI) working on FakeSale

FakeSale is a Manifest V3 browser extension (Brave/Chrome/Edge). Plain JS, no build step, no dependencies.

- **Detection** is in `src/content.js`, which runs on every page. The order of sources is Amazon → JSON-LD → microdata → Open Graph, then Shopify's `/products/<handle>.js` (which supplies `compare_at_price`) is merged on top. If there's still no "was" price, a struck-through price is looked for *near the main price element only*, so related-product carousels don't leak in. When adding a store, prefer structured data over CSS selectors.
- **Listing pages** (opt-in setting `logListings`): `detectListing()` in `src/content.js` tries Amazon search → Shopify collection JSON → JSON-LD ItemList → microdata → a generic card reader, and sends `{type:"listing"}` batches. It only runs when the page isn't a single product page. Single-product JSON-LD parsing deliberately never walks into ItemLists.
- **Identity:** an item's id is `host|sku`, or `host|<alias path>`. `url:<alias>` keys map a normalized product URL to an item id, so a grid sighting and a product-page visit merge even when only one of them has a sku. `aliasKey()` exists in both `content.js` and `storage.js`; `tests/listing.test.mjs` fails if they drift.
- **Verdicts** are in `src/shared/verdict.js` and are covered by `node tests/verdict.test.mjs`. Run `node tests/verdict.test.mjs && node tests/listing.test.mjs` after any change.
- **Data** lives in `chrome.storage.local`, one `item:<id>` key per product plus `url:<alias>` keys. Never change the key format without a migration (see `rebuildAliases()`), or users lose their history.
- **Errors:** every user-facing error has a `FS-###` code from `src/shared/errors.js`, documented in `ERRORS.md`. `scripts/check-errors.sh` enforces this. Never reuse or renumber a code.
- **UI** is `app/` (popup, and also a full tab via `?full`). Preview it without installing: `python3 -m http.server 8790` in the repo root, then open `/tests/ui-harness.html`. It fakes `chrome.*` with sample data.
- **Releases:** bump `manifest.json` version + `RELEASE_NOTES.txt`, push to `main`. The GitHub Action builds `updates/`; never edit `updates/` by hand.
- **Privacy is a feature:** no network calls besides the update check, no analytics, and never read form inputs.
