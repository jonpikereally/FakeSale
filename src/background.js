import { addVisit, findItem, saveItemWithAlias, newItem, logError, getSettings, rebuildAliases } from "./shared/storage.js";
import { analyze } from "./shared/verdict.js";
import { REPO } from "./shared/errors.js";

const FEED = `https://raw.githubusercontent.com/${REPO}/main/updates/latest.json`;
const VERSION = chrome.runtime.getManifest().version;

const BADGES = {
  fake: ["FAKE", "#c62828"],
  real: ["DEAL", "#2e7d32"],
  up: ["UP", "#e65100"],
  unverified: ["?", "#b26a00"],
  steady: ["✓", "#616161"],
  new: ["✓", "#616161"],
};

// Writes go through one queue so two tabs can't overwrite each other's visit.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

async function save(obs) {
  const item = addVisit((await findItem(obs)) || newItem(obs), obs);
  await saveItemWithAlias(item, obs.alias);
  return item;
}

async function setBadge(tabId, text, color, title) {
  if (tabId == null) return;
  await chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  await chrome.action.setTitle({ tabId, title }).catch(() => {});
}

async function record(obs, tabId) {
  const item = await save(obs);
  const v = analyze(item);
  const [text, color] = BADGES[v.kind] || BADGES.new;
  await setBadge(tabId, text, color, `FakeSale: ${v.label}. ${v.text}`);
  await chrome.storage.session.set({ [`tab:${tabId}`]: item.id, [`tabList:${tabId}`]: [] }).catch(() => {});
}

// A search or category page: log every item in the grid. The badge shows how
// many were logged, red if any of them is a fake sale.
async function recordListing(list, tabId) {
  const key = `tabList:${tabId}`;
  const ids = new Set((await chrome.storage.session.get(key).catch(() => ({})))[key] || []);
  for (const obs of list) {
    try { ids.add((await save(obs)).id); } catch (e) { await logError(String(e).includes("QUOTA") ? "FS-302" : "FS-202", `${e && e.stack || e}\nPage: ${obs.host}`); }
  }
  const items = (await chrome.storage.local.get([...ids].map((id) => `item:${id}`)));
  const fakes = Object.values(items).filter((it) => analyze(it).kind === "fake").length;
  await setBadge(tabId, String(ids.size), fakes ? BADGES.fake[1] : BADGES.new[1],
    `FakeSale logged ${ids.size} item${ids.size === 1 ? "" : "s"} on this page${fakes ? `; ${fakes} look like fake sales` : ""}.`);
  await chrome.storage.session.set({ [key]: [...ids], [`tab:${tabId}`]: null }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "observation") {
    serial(() => record(msg.data, sender.tab && sender.tab.id)).catch((e) =>
      logError(String(e).includes("QUOTA") ? "FS-302" : "FS-202", `${e && e.stack || e}\nPage: ${msg.data && msg.data.host}`)
    );
  } else if (msg.type === "listing") {
    serial(() => recordListing(msg.data || [], sender.tab && sender.tab.id)).catch((e) => logError("FS-203", e && e.stack || e));
  } else if (msg.type === "error") {
    logError(msg.code, msg.details);
  } else if (msg.type === "checkUpdates") {
    checkForUpdates(true).then(reply);
    return true;
  }
});

// ---------- updates ----------
// Unpacked extensions can't replace their own files, so this only tells you
// a newer version exists; the app page shows how to install it.

function newer(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function checkForUpdates(manual = false) {
  const { updateSource } = await getSettings();
  const feed = updateSource || FEED;
  let state;
  try {
    let res;
    try {
      res = await fetch(feed, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      throw Object.assign(new Error(`${feed}: ${e.message}`), { code: "FS-101" });
    }
    let latest;
    try {
      latest = await res.json();
      if (!latest.version) throw new Error("no version field");
    } catch (e) {
      throw Object.assign(new Error(`${feed}: ${e.message}`), { code: "FS-102" });
    }
    state = {
      checkedAt: Date.now(),
      current: VERSION,
      latest: latest.version,
      available: newer(latest.version, VERSION),
      notes: latest.notes || "",
      url: latest.url ? new URL(latest.url, feed).toString() : null,
    };
  } catch (e) {
    state = { checkedAt: Date.now(), current: VERSION, available: false, error: { code: e.code || "FS-999", details: e.message } };
    if (manual) await logError(state.error.code, state.error.details);
  }
  await chrome.storage.local.set({ update: state });
  await chrome.action.setTitle({ title: state.available ? `FakeSale: update to v${state.latest} available` : "FakeSale" });
  return state;
}

chrome.alarms.create("updates", { periodInMinutes: 6 * 60 });
chrome.alarms.onAlarm.addListener((a) => a.name === "updates" && checkForUpdates());
chrome.runtime.onStartup.addListener(() => setTimeout(checkForUpdates, 5000));
chrome.runtime.onInstalled.addListener(() => {
  rebuildAliases().catch((e) => logError("FS-301", e && e.stack || e));
  setTimeout(checkForUpdates, 5000);
});
