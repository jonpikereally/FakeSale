// All data stays in this browser (chrome.storage.local). One key per item:
//   "item:<id>" -> { id, name, host, url, image, sku, currency, firstSeen, lastSeen, visits: [...] }
//   visit       -> { t, price, original, currency, source, n, list }
//                  (n = reloads folded in; list = seen in a search/category grid)
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
    item.visits.push(visit);
  }
  // A product page knows the item best; a grid only fills in what's missing.
  Object.assign(item, {
    name: (fromList ? item.name || obs.name : obs.name || item.name),
    url: fromList && item.url ? item.url : obs.url,
    image: (fromList ? item.image || obs.image : obs.image || item.image),
    currency: obs.currency || item.currency,
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
  return { updateSource: "", ...settings };
}

export async function saveSettings(patch) {
  const s = await getSettings();
  await chrome.storage.local.set({ settings: { ...s, ...patch } });
}
