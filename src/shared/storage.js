// All data stays in this browser (chrome.storage.local). One key per item:
//   "item:<id>" -> { id, name, host, url, image, sku, currency, firstSeen, lastSeen, visits: [...] }
//   visit       -> { t, price, original, currency, source, n }   (n = reloads folded in)
// Plus "errors" (last 100 coded errors) and "settings".

const ITEM = "item:";
const MERGE_WINDOW = 30 * 60 * 1000; // same price within 30 min = same visit (reloads)

export const itemId = (o) => `${o.host}|${o.sku || new URL(o.url).pathname + new URL(o.url).search}`;

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
  await chrome.storage.local.remove(ITEM + id);
}

export function addVisit(item, obs, t = Date.now()) {
  const last = item.visits[item.visits.length - 1];
  if (last && t - last.t < MERGE_WINDOW && last.price === obs.price && last.original === obs.original) {
    last.n = (last.n || 1) + 1;
    last.t = t;
  } else {
    item.visits.push({ t, price: obs.price, original: obs.original, currency: obs.currency, source: obs.source });
  }
  Object.assign(item, {
    name: obs.name || item.name,
    url: obs.url,
    image: obs.image || item.image,
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
