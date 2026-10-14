# FakeSale

A browser extension for Brave, Chrome, Edge and other Chromium browsers that **calls out fake sales**.

Stores love a big red "was $199, now $129!" when the item has never actually sold for $199. FakeSale quietly logs the price of every product page you visit, plus any "original" or "was" price the store shows. Over time it can tell you which discounts are real and which are made up.

## What it does

- **Logs every product page automatically.** It saves the price, the store's claimed original price, and the time. Reloading within 30 minutes at the same price counts as one visit.
- **Gives each item a verdict**, also shown as a badge on the toolbar icon:
  - **✕ Fake sale.** The store claims a discount, but in 7+ days of your visits you have never seen it at the "was" price.
  - **✓ Real sale / real drop.** You did see it at the "was" price, or it's now cheaper than what you usually saw.
  - **? Unverified.** It claims a discount but you haven't watched it long enough to judge yet.
  - **▲ Price up.** It costs more than it used to, sometimes while still claiming a discount.
- **Can also log whole lists (optional).** Turn on Settings → *Also log items on search & category pages*, and every item in a grid of results gets a price entry too. Browsing a "Sale" section then builds history for all of it. The badge shows how many items were logged (red if any look fake), and the popup offers to show just those. Grid sightings and product-page visits of the same item share one history; grid sightings are tagged "list" in the visit table.
- **Labels items with your own rules.** In Settings → *Property rules*, say things like "anything whose address starts with `long-mcquade.com/GearHunter/` has **Condition: Used**". Items show the label, and the list can be filtered by it. Rules apply to everything already logged, and match either the item's own page or the list page it was seen on. Use `*` to match anything (e.g. `amazon.*/renewed`). When a store publishes an item's condition itself (Used, Refurbished…), that's picked up automatically; your rules take priority.
- **Lets you browse your history.** Click the toolbar icon to see everything you've viewed. You can search, filter by verdict and sort. Each item has a price chart (your price vs. the store's "was" price) and a table of every visit. Click ⤢ to open it in a full tab.
- **Backs up and restores** to a JSON file (Settings → Export / Import).

FakeSale can only judge what you've seen. Its history starts the first time you visit an item, so a verdict gets stronger the more often you come back.

## Privacy

Everything stays in your browser (`chrome.storage.local`). FakeSale has no server, no account and no analytics. The only network request it makes is a check of this repo's `updates/latest.json` for new versions. It reads product data from the page (structured product data, price elements and the struck-through "was" price near the main price). It never reads form fields or anything you type. Tracking parameters such as `utm_*` and `fbclid` are stripped from saved URLs.

## Install (Brave)

1. Download the latest [FakeSale.zip](https://github.com/jonpikereally/FakeSale/raw/main/updates/FakeSale.zip) and unzip it somewhere permanent (not Downloads, which gets cleaned). Or clone this repo.
2. Open `brave://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `FakeSale` folder (the one containing `manifest.json`).
4. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to FakeSale.

The same steps work in Chrome (`chrome://extensions`) and Edge (`edge://extensions`).

## Updating

FakeSale checks this repo for new versions at startup and every 6 hours, and shows a banner when one exists. You can also check by hand in Settings → Check for Updates…. Browsers don't let unpacked extensions replace their own files, so to install an update:

- **If you cloned the repo:** run `git pull`, then click ↻ on FakeSale in `brave://extensions`.
- **If you used the zip:** download the new zip, replace the folder's contents, then click ↻.

Your price history is kept either way, because it lives in the browser, not the folder. Don't *remove* the extension, though: removing it deletes its data. Export a backup first if you ever need to.

## Which stores work?

Any store that publishes standard product data, which is most of them: schema.org JSON-LD, microdata, or Open Graph product tags. On top of that, FakeSale has special handling for:

- **Amazon** (all regions): reads the list price / typical price.
- **Shopify stores**: reads `compare_at_price` straight from the store's product data.
- **Long & McQuade GearHunter**: reads sale and regular prices from item pages.

For lists (search results, categories, collections), FakeSale reads Amazon search results, Shopify collections (one request gets every price, including `compare_at_price`), structured item lists, and, on other stores, a general "product card" reader that finds the price, struck-through "was" price, name and link in each card of the grid. Lists are capped at 300 items per page, and infinite-scroll pages are re-read as more items load.

If a store isn't detected, or the "was" price is missed, please [open an issue](https://github.com/jonpikereally/FakeSale/issues) with the link.

## Errors

Every error FakeSale shows has a code (e.g. `FS-301`) and a **Copy Error Details** button. See [ERRORS.md](ERRORS.md) for the full list.

## Development

No build step. The extension is plain JavaScript (Manifest V3):

| Path | What it is |
|---|---|
| `manifest.json` | Extension manifest; `version` here is the release version |
| `src/content.js` | Runs on every page; reads product pages and (optionally) listing grids |
| `src/background.js` | Service worker; saves visits, sets the badge, checks for updates |
| `src/shared/verdict.js` | The real-vs-fake logic |
| `src/shared/rules.js` | Property rules (URL prefix → property) |
| `src/shared/storage.js` | Data model and storage helpers |
| `src/shared/errors.js` | Error code catalogue (keep in sync with `ERRORS.md`) |
| `app/` | The popup / full-tab history browser |

To test the detector on any page, load the extension and run `await __fakeSale.detect()` (product pages) or `await __fakeSale.detectListing()` (grids) in the page's DevTools console (choose the FakeSale context in the console's context dropdown). Tests: `node tests/verdict.test.mjs && node tests/listing.test.mjs && node tests/rules.test.mjs`.

**Releasing:** bump `version` in `manifest.json`, write `RELEASE_NOTES.txt`, and push to `main`. The GitHub Action builds `updates/FakeSale.zip` and `updates/latest.json`. Don't edit `updates/` by hand. `scripts/check-errors.sh` fails the build if a code in the source is missing from `ERRORS.md`.

## License

MIT
