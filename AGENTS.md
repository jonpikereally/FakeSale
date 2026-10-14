# Brief for anyone (human or AI) working on FakeSale

FakeSale is a Manifest V3 browser extension (Brave/Chrome/Edge). Plain JS, no build step, no dependencies.

- **Detection** is in `src/content.js`, which runs on every page. The order of sources is Amazon → JSON-LD → microdata → Open Graph, then Shopify's `/products/<handle>.js` (which supplies `compare_at_price`) is merged on top. If there's still no "was" price, a struck-through price is looked for *near the main price element only*, so related-product carousels don't leak in. When adding a store, prefer structured data over CSS selectors.
- **Verdicts** are in `src/shared/verdict.js` and are covered by `node tests/verdict.test.mjs`. Run the tests after any change there.
- **Data** lives in `chrome.storage.local`, one `item:<host>|<sku-or-path>` key per product. Never change the key format without a migration, or users lose their history.
- **Errors:** every user-facing error has a `FS-###` code from `src/shared/errors.js`, documented in `ERRORS.md`. `scripts/check-errors.sh` enforces this. Never reuse or renumber a code.
- **UI** is `app/` (popup, and also a full tab via `?full`). Preview it without installing: `python3 -m http.server 8790` in the repo root, then open `/tests/ui-harness.html`. It fakes `chrome.*` with sample data.
- **Releases:** bump `manifest.json` version + `RELEASE_NOTES.txt`, push to `main`. The GitHub Action builds `updates/`; never edit `updates/` by hand.
- **Privacy is a feature:** no network calls besides the update check, no analytics, and never read form inputs.
