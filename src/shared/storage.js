// All data stays in this browser (chrome.storage.local). One key per item:
//   "item:<id>" -> { id, name, host, url, image, sku, currency, firstSeen, lastSeen, visits: [...] }
//   visit       -> { t, price, original, currency, source, n, list, page }
//                  (n = reloads folded in; list = seen in a search/category grid;
//                   page = that grid's address, which property rules can match)
//   "url:<alias>" -> item id. Lets a product seen in a grid and on its own
//                  page share one history even when the store labels them differently.
// Plus "errors" (last 100 coded errors) and "settings".

const ITEM = "item:";
const MERGE_WINDOW = 30 * 60 * 1000; // same price within 30 min = same visit (reloads)

const ALIAS = "url:";

// Must match aliasKey() in src/content.js (tests/verdict.test.mjs checks they agree).
const ID_PARAMS = /^(variant|pid|productid|product_id|prodid|sku|skuid|itemid|item_id|id)$/i;
export function aliasKey(raw) {
  const u = new URL(raw);
  const host = u.hostname.replace(/^www\./, "");
  let path = u.pathname.replace(/\/collections\/[^/]+(\/products\/)/i, "$1").replace(/\/+$/, "").toLowerCase();
  const asin = path.match(/\/(?:dp|gp\/product)\/([a-z0-9]{10})/);
  if (asin && /(^|\.)amazon\./.test(host)) path = `/dp/${asin[1]}`;
  const keep = [...u.searchParams].filter(([k]) => ID_PARAMS.test(k)).map(([k, v]) => `${k.toLowerCase()}=${v}`).sort();
  return host + path + (keep.length ? "?" + keep.join("&") : "");
}

export const itemId = (o) => `${o.host}|${o.sku || (o.alias || aliasKey(o.url)).slice(o.host.length) || "/"}`;

// Finds this product's history by id, then by its URL alias.
export async function findItem(obs) {
  const byId = await getItem(itemId(obs));
  if (byId) return byId;
  const key = ALIAS + (obs.alias || aliasKey(obs.url));
  const id = (await chrome.storage.local.get(key))[key];
  return id ? getItem(id) : null;
}

export async function saveItemWithAlias(item, alias) {
  await chrome.storage.local.set({ [ITEM + item.id]: item, [ALIAS + (alias || aliasKey(item.url))]: item.id });
}

// Drops the visits bad(visit, item) picks out, once (tag goes in "migrations").
// Items left with no visits are deleted along with their aliases; they get
// re-logged correctly next time they're seen.
async function dropVisits(tag, bad) {
  const { migrations = [] } = await chrome.storage.local.get("migrations");
  if (migrations.includes(tag)) return 0;
  const all = await chrome.storage.local.get(null);
  const patch = {}, remove = [];
  let dropped = 0;
  for (const [k, item] of Object.entries(all)) {
    if (!k.startsWith(ITEM) || !Array.isArray(item.visits)) continue;
    const keep = item.visits.filter((v) => !bad(v, item));
    if (keep.length === item.visits.length) continue;
    dropped += item.visits.length - keep.length;
    if (keep.length) {
      patch[k] = { ...item, visits: keep, firstSeen: keep[0].t, lastSeen: keep[keep.length - 1].t };
    } else {
      remove.push(k, ...Object.keys(all).filter((a) => a.startsWith(ALIAS) && all[a] === item.id));
    }
  }
  patch.migrations = [...migrations, tag];
  await chrome.storage.local.set(patch);
  if (remove.length) await chrome.storage.local.remove(remove);
  return dropped;
}

// One-time repair (v1.2.1): v1.1's generic grid reader could log a monthly
// financing amount ("$267/mo") as the price, and missed labelled "Regular
// Price" originals. Its sightings are recognisable (source "list:page", no
// page field), so drop them. Product-page visits and other readers are untouched.
export const dropV11GenericListVisits = () =>
  dropVisits("1.2.1-generic-list", (v) => v.source === "list:page" && v.list && !v.page);

// Same list as PRIVATE_PAGE in src/content.js.
const PRIVATE_PAGE = /\/(cart|basket|bag|checkout|buy|orders?|order-history|order-details|thankyou|thank-you|account|your-account)(\/|$|[.?#])/i;
const pathOf = (u) => { try { return new URL(u).pathname; } catch { return ""; } };

// One-time repair (v1.2.3): before v1.2.3 the generic grid reader (source
// "list:page") could log a discount badge as the price ("-5%" -> $5), an
// Amazon unit price ($0.28/count), or a "Save $20" amount, and it read your
// own cart and order history. Drop those sightings:
//  - every generic-reader sighting on Amazon and Canadian Tire, where these
//    mistakes were common (Amazon search pages use their own reader, untouched);
//  - any generic sighting from a cart, checkout or order page;
//  - any grid sighting of an item whose "name" is a badge like "-5%";
//  - Facebook "items" that are a group or city page, not a Marketplace listing.
const BADGE_NAME = /^\s*[-−–]?\d+(?:[.,]\d+)?\s*%(\s*off)?\s*$|^\s*(\d+\s+)?new offers?\s*$/i;
export const dropBadGridVisits = () =>
  dropVisits("1.2.3-bad-grid", (v, item) => (v.list && BADGE_NAME.test(item.name || "")) || (v.source === "list:page" && (
    /(^|\.)amazon\./.test(item.host) || item.host === "canadiantire.ca" ||
    PRIVATE_PAGE.test(pathOf(v.page)) ||
    (item.host === "facebook.com" && !/^\/marketplace\/item\//.test(pathOf(item.url))))));

// One-time upgrade for items saved before aliases existed (v1.0.0).
export async function rebuildAliases() {
  const all = await chrome.storage.local.get(null);
  const patch = {};
  for (const [k, item] of Object.entries(all)) {
    if (!k.startsWith(ITEM) || !item.url) continue;
    try {
      const key = ALIAS + aliasKey(item.url);
      if (!all[key]) patch[key] = item.id;
    } catch { /* unparseable URL: skip */ }
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

export async function getAllItems() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all).filter(([k]) => k.startsWith(ITEM)).map(([, v]) => v);
}

export async function getItem(id) {
  const key = ITEM + id;
  return (await chrome.storage.local.get(key))[key] || null;
}

export async function putItem(item) {
  await chrome.storage.local.set({ [ITEM + item.id]: item });
}

export async function deleteItem(id) {
  const all = await chrome.storage.local.get(null);
  const aliases = Object.keys(all).filter((k) => k.startsWith(ALIAS) && all[k] === id);
  await chrome.storage.local.remove([ITEM + id, ...aliases]);
}

export function addVisit(item, obs, t = Date.now()) {
  const fromList = String(obs.source || "").startsWith("list:");
  const last = item.visits[item.visits.length - 1];
  if (last && t - last.t < MERGE_WINDOW && last.price === obs.price && last.original === obs.original) {
    last.n = (last.n || 1) + 1;
    last.t = t;
    if (!fromList) delete last.list; // you opened the page too
  } else {
    const visit = { t, price: obs.price, original: obs.original, currency: obs.currency, source: obs.source };
    if (fromList) visit.list = true;
    if (obs.page) visit.page = obs.page; // the list page it was seen on (used by property rules)
    item.visits.push(visit);
  }
  // A product page knows the item best; a grid only fills in what's missing.
  Object.assign(item, {
    name: (fromList ? item.name || obs.name : obs.name || item.name),
    url: fromList && item.url ? item.url : obs.url,
    image: (fromList ? item.image || obs.image : obs.image || item.image),
    currency: obs.currency || item.currency,
    condition: obs.condition || item.condition || null,
    lastSeen: t,
  });
  return item;
}

export function newItem(obs, t = Date.now()) {
  return { id: itemId(obs), host: obs.host, sku: obs.sku, url: obs.url, name: obs.name, image: obs.image,
    currency: obs.currency, firstSeen: t, lastSeen: t, visits: [] };
}

export async function logError(code, details) {
  const { errors = [] } = await chrome.storage.local.get("errors");
  errors.push({ code, details: details ? String(details).slice(0, 2000) : null, t: Date.now() });
  await chrome.storage.local.set({ errors: errors.slice(-100) });
  console.warn(`FakeSale ${code}`, details || "");
}

export async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  return { updateSource: "", logListings: false, rules: [], ...settings };
}

export async function saveSettings(patch) {
  const s = await getSettings();
  await chrome.storage.local.set({ settings: { ...s, ...patch } });
}
