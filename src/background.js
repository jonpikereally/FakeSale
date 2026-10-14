import { addVisit, getItem, putItem, newItem, itemId, logError, getSettings } from "./shared/storage.js";
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

async function record(obs, tabId) {
  const id = itemId(obs);
  const item = addVisit((await getItem(id)) || newItem(obs), obs);
  await putItem(item);
  const v = analyze(item);
  const [text, color] = BADGES[v.kind] || BADGES.new;
  if (tabId != null) {
    await chrome.action.setBadgeText({ tabId, text }).catch(() => {});
    await chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
    await chrome.action.setTitle({ tabId, title: `FakeSale: ${v.label}. ${v.text}` }).catch(() => {});
  }
  await chrome.storage.session.set({ [`tab:${tabId}`]: id }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "observation") {
    serial(() => record(msg.data, sender.tab && sender.tab.id)).catch((e) =>
      logError(String(e).includes("QUOTA") ? "FS-302" : "FS-202", `${e && e.stack || e}\nPage: ${msg.data && msg.data.host}`)
    );
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
chrome.runtime.onInstalled.addListener(() => setTimeout(checkForUpdates, 5000));
