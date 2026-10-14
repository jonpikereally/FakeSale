import { getAllItems, getItem, putItem, deleteItem, getSettings, saveSettings, logError, rebuildAliases } from "../src/shared/storage.js";
import { analyze, fmt } from "../src/shared/verdict.js";
import { describe, detailsText, ERROR_HOVER, ERROR_LIST_URL, REPO } from "../src/shared/errors.js";
import { propsFor, urlMatches, suggestPattern } from "../src/shared/rules.js";

const VERSION = chrome.runtime.getManifest().version;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ICON = { fake: "✕", real: "✓", up: "▲", unverified: "?", steady: "•", new: "•" };
const pill = (v) => `<span class="pill ${v.kind}">${ICON[v.kind]} ${esc(v.label)}</span>`;
const when = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const whenTime = (t) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

const isFull = new URLSearchParams(location.search).has("full");
if (isFull) { document.body.classList.add("full"); $("#openTab").hidden = true; }

let items = [];
let filter = "all";
let pageIds = null; // when set, the list shows only items logged on the current tab's page
let rules = [];      // property rules from Settings
let propFilter = ""; // JSON ["Prop","Value"], or "" for any
let tabUrl = null;   // the page the popup was opened on (for "Use the current tab's address")
const propChips = (props) => {
  const e = Object.entries(props);
  return e.length ? `<span class="props">${e.map(([k, v]) => `<span class="prop" title="${esc(k)}: ${esc(v)}">${k === "Condition" ? "" : `${esc(k)}: `}<b>${esc(v)}</b></span>`).join("")}</span>` : "";
};

// ---------- errors: every one shows a code, hover text, a "?" link, and Copy Details ----------

function errorBanner(err, onDismiss) {
  const d = describe(err.code);
  const el = document.createElement("div");
  el.className = "banner error";
  el.title = ERROR_HOVER;
  el.innerHTML = `
    <span class="grow" title="${esc(ERROR_HOVER)}">⚠️ <span class="err-code" title="${esc(ERROR_HOVER)}">Error code: ${esc(d.code)}</span>
      <a class="help" href="${ERROR_LIST_URL}" target="_blank" title="${esc(ERROR_HOVER)}">?</a><br>
      <span title="${esc(ERROR_HOVER)}">${esc(d.summary)} ${esc(d.hint)}</span></span>
    <button class="btn copy">Copy Error Details</button>
    <button class="btn dismiss">Dismiss</button>`;
  el.querySelector(".copy").onclick = async (e) => {
    await navigator.clipboard.writeText(detailsText(err, VERSION));
    e.target.textContent = "Copied";
  };
  el.querySelector(".dismiss").onclick = () => { el.remove(); onDismiss && onDismiss(); };
  return el;
}

async function showError(code, details) {
  await logError(code, details);
  $("#banners").prepend(errorBanner({ code, details, t: Date.now() }));
}

// Wraps any action so failures surface with a code instead of vanishing.
const guard = (code, fn) => async (...args) => {
  try { return await fn(...args); } catch (e) { showError(e.code || code, e.stack || String(e)); }
};

async function renderBanners() {
  const box = $("#banners");
  box.innerHTML = "";
  const { errors = [], update, settings = {} } = await chrome.storage.local.get(["errors", "update", "settings"]);
  const seen = settings.errorsSeenAt || 0;
  for (const err of errors.filter((e) => e.t > seen).slice(-3).reverse()) {
    box.append(errorBanner(err, () => saveSettings({ errorsSeenAt: err.t })));
  }
  if (update && update.available) box.prepend(updateBanner(update));
}

function updateBanner(u) {
  const el = document.createElement("div");
  el.className = "banner update";
  el.innerHTML = `<span class="grow">⬆︎ <strong>FakeSale v${esc(u.latest)} is available</strong> (you have v${esc(u.current)}).
    ${u.notes ? `<br>${esc(u.notes)}` : ""}
    <br>To install: download it, replace your FakeSale folder with the new one, then click ↻ on FakeSale in brave://extensions.
    If you cloned the repo, run <code>git pull</code> instead. Your price history is kept either way.</span>
    ${u.url ? `<a class="btn" href="${esc(u.url)}" target="_blank">Download</a>` : ""}`;
  return el;
}

// ---------- list ----------

function sparkline(item, w = 64, h = 18) {
  const ps = item.visits.map((v) => v.price);
  if (ps.length < 2) return "";
  const lo = Math.min(...ps), hi = Math.max(...ps), span = hi - lo || 1;
  const pts = ps.map((p, i) => `${(i / (ps.length - 1)) * (w - 4) + 2},${h - 2 - ((p - lo) / span) * (h - 4)}`).join(" ");
  return `<svg class="spark" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--series-price)" stroke-width="1.5"/></svg>`;
}

function row(item, v) {
  const last = item.visits[item.visits.length - 1];
  const img = item.image ? `<img class="thumb" src="${esc(item.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="thumb none"></div>`;
  return `<li class="item" data-id="${esc(item.id)}">
    ${img}
    <div><div class="name">${esc(item.name || item.url)}</div>
      <div class="sub">${pill(v)} ${propChips(propsFor(item, rules))} <span>${esc(item.host)}</span> · <span>${item.visits.length} visit${item.visits.length === 1 ? "" : "s"}</span></div></div>
    <div class="prices"><div class="now">${fmt(last.price, last.currency)}</div>
      ${last.original ? `<div class="was">${fmt(last.original, last.currency)}</div>` : ""}${sparkline(item)}</div>
  </li>`;
}

// The property filter lists every "Prop: Value" that some item has.
function renderPropFilter() {
  const sel = $("#propFilter");
  const seen = new Map();
  for (const it of items) for (const [k, v] of Object.entries(propsFor(it, rules))) seen.set(JSON.stringify([k, v]), `${k}: ${v}`);
  if (propFilter && !seen.has(propFilter)) propFilter = "";
  sel.hidden = !seen.size;
  sel.innerHTML = `<option value="">Any property</option>` +
    [...seen].sort((a, b) => a[1].localeCompare(b[1])).map(([val, label]) => `<option value="${esc(val)}"${val === propFilter ? " selected" : ""}>${esc(label)}</option>`).join("");
}

function renderList() {
  const q = $("#search").value.trim().toLowerCase();
  const sort = $("#sort").value;
  let rows = items.map((it) => ({ it, v: analyze(it), props: propsFor(it, rules) }));
  if (q) rows = rows.filter(({ it, props }) => `${it.name} ${it.host} ${Object.values(props).join(" ")}`.toLowerCase().includes(q));
  if (propFilter) {
    const [k, val] = JSON.parse(propFilter);
    rows = rows.filter(({ props }) => props[k] === val);
  }
  if (filter !== "all") rows = rows.filter(({ v }) => v.kind === filter);
  if (pageIds) rows = rows.filter(({ it }) => pageIds.has(it.id));
  $("#pageFilter").hidden = !pageIds;
  const drop = ({ it, v }) => (v.typical ? 1 - it.visits.at(-1).price / v.typical : 0);
  const sorters = {
    recent: (a, b) => b.it.lastSeen - a.it.lastSeen,
    claimed: (a, b) => (b.v.claimedPct || 0) - (a.v.claimedPct || 0),
    drop: (a, b) => drop(b) - drop(a),
    visits: (a, b) => b.it.visits.length - a.it.visits.length,
    name: (a, b) => String(a.it.name).localeCompare(String(b.it.name)),
  };
  rows.sort(sorters[sort]);
  $("#list").innerHTML = rows.map(({ it, v }) => row(it, v)).join("");
  $("#empty").hidden = items.length > 0;
  if (items.length && !rows.length) $("#list").innerHTML = `<p class="empty">No items match.</p>`;
}

async function renderCurrent() {
  const box = $("#current");
  box.innerHTML = "";
  if (isFull) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const key = `tab:${tab.id}`, listKey = `tabList:${tab.id}`;
  const got = await chrome.storage.session.get([key, listKey]);
  const item = got[key] && items.find((i) => i.id === got[key]);
  if (item) {
    box.innerHTML = `<div class="current"><div class="label">This page</div><ul class="list">${row(item, analyze(item))}</ul></div>`;
    return;
  }
  const ids = new Set(got[listKey] || []);
  const onPage = items.filter((i) => ids.has(i.id));
  if (!onPage.length) return;
  const counts = {};
  onPage.forEach((i) => { const k = analyze(i).kind; counts[k] = (counts[k] || 0) + 1; });
  const parts = [["fake", "fake"], ["real", "real deals"], ["unverified", "unverified"], ["up", "price up"]]
    .filter(([k]) => counts[k]).map(([k, label]) => `<span class="pill ${k}">${ICON[k]} ${counts[k]} ${label}</span>`).join(" ");
  box.innerHTML = `<div class="current"><div class="label">This page</div>
    <div>Logged <strong>${onPage.length}</strong> item${onPage.length === 1 ? "" : "s"} from this list. ${parts}</div>
    <p class="row" style="margin:8px 0 0"><button class="btn" id="showPage">Show them</button></p></div>`;
  $("#showPage").onclick = () => { pageIds = ids; renderList(); };
}

// ---------- detail ----------

// Round tick spacing to 1, 2, 2.5 or 5 x a power of ten so axis labels are clean.
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return p * (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10);
}

function chart(item, width) {
  const vs = item.visits;
  const W = Math.max(300, Math.round(width)), H = Math.round(Math.min(260, W * 0.45)), L = 56, R = 12, T = 12, B = 24;
  const cur = item.currency;
  const all = vs.flatMap((v) => [v.price, v.original].filter(Boolean));
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi === lo) { lo -= hi * 0.1 || 1; hi += hi * 0.1 || 1; }
  const stepV = niceStep((hi - lo) / 4);
  lo = Math.max(0, Math.floor(lo / stepV) * stepV); hi = Math.ceil(hi / stepV) * stepV;
  const ticks = Math.round((hi - lo) / stepV);
  const t0 = vs[0].t, t1 = vs.at(-1).t, tspan = t1 - t0 || 1;
  const x = (t) => (vs.length === 1 ? (L + W - R) / 2 : L + ((t - t0) / tspan) * (W - L - R));
  const y = (p) => T + (1 - (p - lo) / (hi - lo)) * (H - T - B);

  // Step lines: a price holds until the next visit shows a different one.
  const step = (key) => {
    let d = "", open = false;
    vs.forEach((v, i) => {
      const val = v[key];
      if (!val) { open = false; return; }
      const px = x(v.t), py = y(val);
      if (!open) { d += `M${px},${py}`; open = true; }
      else d += `H${px}V${py}`;
      const next = vs[i + 1];
      if (next && next[key]) d += `H${x(next.t)}`;
    });
    return d;
  };

  let grid = "";
  for (let i = 0; i <= ticks; i++) {
    const p = lo + ((hi - lo) * i) / ticks, py = y(p);
    grid += `<line class="grid" x1="${L}" x2="${W - R}" y1="${py}" y2="${py}"/><text class="axis" x="${L - 6}" y="${py + 3}" text-anchor="end">${esc(fmt(p, cur))}</text>`;
  }
  const xl = vs.length === 1 ? [vs[0].t] : [t0, t0 + tspan / 2, t1];
  const xlabels = xl.map((t, i) => `<text class="axis" x="${x(t)}" y="${H - 8}" text-anchor="${vs.length === 1 ? "middle" : ["start", "middle", "end"][i]}">${esc(when(t))}</text>`).join("");
  const dots = vs.map((v) => `<circle class="dot" cx="${x(v.t)}" cy="${y(v.price)}" r="4"/>`).join("");
  const wasDots = vs.filter((v) => v.original).map((v) => `<circle class="dot was" cx="${x(v.t)}" cy="${y(v.original)}" r="3.5"/>`).join("");
  const last = vs.at(-1);
  const lbl = `<text class="lbl" x="${Math.min(x(last.t), W - R) - 4}" y="${y(last.price) - 9}" text-anchor="end">${esc(fmt(last.price, cur))}</text>`;

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Price history chart">
    ${grid}${xlabels}
    <path class="was" d="${step("original")}"/>
    <path class="price" d="${step("price")}"/>
    ${wasDots}${dots}${lbl}
    <line class="cross" id="cross" y1="${T}" y2="${H - B}" visibility="hidden"/>
    <rect id="hit" x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent"/>
  </svg>`;
}

function wireChartHover(item) {
  const svg = $(".chart"), hit = $("#hit"), cross = $("#cross"), tip = $("#tooltip");
  if (!svg) return;
  const vs = item.visits;
  const xs = [...svg.querySelectorAll("circle.dot:not(.was)")].map((c) => +c.getAttribute("cx"));
  hit.addEventListener("mousemove", (e) => {
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
    let i = 0;
    xs.forEach((cx, j) => { if (Math.abs(cx - pt.x) < Math.abs(xs[i] - pt.x)) i = j; });
    const v = vs[i];
    cross.setAttribute("x1", xs[i]); cross.setAttribute("x2", xs[i]); cross.setAttribute("visibility", "visible");
    tip.innerHTML = `<div>${esc(whenTime(v.t))}</div><strong>${esc(fmt(v.price, v.currency))}</strong>${v.original ? ` <span class="t-was">was ${esc(fmt(v.original, v.currency))}</span>` : ""}`;
    tip.hidden = false;
    tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px";
    tip.style.top = e.clientY - tip.offsetHeight - 10 + "px";
  });
  hit.addEventListener("mouseleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); });
}

async function showDetail(id) {
  const item = await getItem(id);
  if (!item) return showList();
  const v = analyze(item);
  const last = item.visits.at(-1);
  const cur = item.currency;
  const img = item.image ? `<img class="thumb" src="${esc(item.image)}" alt="" referrerpolicy="no-referrer">` : `<div class="thumb none"></div>`;
  const visitsRows = [...item.visits].reverse().map((x) => {
    const pct = x.original ? Math.round((1 - x.price / x.original) * 100) + "%" : "";
    return `<tr><td>${esc(whenTime(x.t))}${x.n > 1 ? ` <span class="muted">(×${x.n})</span>` : ""}${x.list ? `<span class="tag" title="Seen in a search or category list, not on the item's own page">list</span>` : ""}</td>
      <td class="num">${esc(fmt(x.price, x.currency))}</td><td class="num">${x.original ? esc(fmt(x.original, x.currency)) : "—"}</td><td class="num">${pct}</td></tr>`;
  }).join("");
  const hasWas = item.visits.some((x) => x.original);

  $("#detailView").innerHTML = `
    <div class="detail-head">${img}
      <div><div class="name" style="-webkit-line-clamp:3">${esc(item.name)}</div>
        <div class="sub">${propChips(propsFor(item, rules))} <span>${esc(item.host)}</span> · <a href="${esc(item.url)}" target="_blank">Open page</a></div>
        <div style="margin-top:6px"><span class="now" style="font-size:18px">${fmt(last.price, cur)}</span>
        ${last.original ? ` <span class="was">${fmt(last.original, cur)}</span>` : ""}</div></div></div>
    <div class="verdict ${v.kind}"><strong>${ICON[v.kind]} ${esc(v.label)}</strong>${esc(v.text)}</div>
    <div class="stats">
      <div class="stat"><div class="k">Lowest seen</div><div class="v">${fmt(v.low, cur)}</div></div>
      <div class="stat"><div class="k">Highest seen</div><div class="v">${fmt(v.high, cur)}</div></div>
      <div class="stat"><div class="k">First seen</div><div class="v">${esc(when(item.firstSeen))}</div></div>
      <div class="stat"><div class="k">Visits</div><div class="v">${item.visits.length}</div></div>
    </div>
    <div class="legend"><span><i></i>Price you saw</span>${hasWas ? `<span><i class="was"></i>Store's "was" price</span>` : ""}</div>
    <div id="chartBox"></div>
    <table><thead><tr><th>Visit</th><th class="num">Price</th><th class="num">"Was"</th><th class="num">Claimed off</th></tr></thead><tbody>${visitsRows}</tbody></table>
    <p class="row" style="margin-top:14px"><button class="btn danger" id="del">Delete this item</button></p>`;
  $("#del").onclick = guard("FS-302", async () => {
    if (!confirm("Delete this item and its whole price history?")) return;
    await deleteItem(id);
    items = items.filter((i) => i.id !== id);
    showList();
  });
  setView("detail", item.name);
  $("#chartBox").innerHTML = chart(item, $("#chartBox").clientWidth);
  wireChartHover(item);
}

// ---------- views ----------

function setView(name, title) {
  $("#listView").hidden = name !== "list";
  $("#detailView").hidden = name !== "detail";
  $("#settingsView").hidden = name !== "settings";
  $("#back").hidden = name === "list";
  $("#title").textContent = title || "FakeSale";
  scrollTo(0, 0);
}

function showList() { setView("list"); renderPropFilter(); renderList(); }

// ---------- property rules ----------

function renderRules() {
  $("#rules").innerHTML = rules.length ? rules.map((r) => {
    const n = items.filter((it) => propsFor(it, [r])[r.prop] === r.value).length;
    return `<li><code title="${esc(r.match)}">${esc(r.match)}</code><span>→ ${esc(r.prop)}: <strong>${esc(r.value)}</strong></span>
      <span class="muted">${n} item${n === 1 ? "" : "s"}</span><button class="icon-btn" data-del="${esc(r.id)}" title="Delete rule" aria-label="Delete rule">✕</button></li>`;
  }).join("") : `<li class="muted">No rules yet.</li>`;
}

const saveRules = guard("FS-302", async () => {
  await saveSettings({ rules });
  renderRules();
});

$("#rules").onclick = (e) => {
  const id = e.target.closest("[data-del]")?.dataset.del;
  if (!id) return;
  rules = rules.filter((r) => r.id !== id);
  saveRules();
};
$("#ruleAdd").onclick = () => {
  const match = $("#ruleMatch").value.trim(), prop = $("#ruleProp").value.trim(), value = $("#ruleValue").value.trim();
  const msg = $("#ruleMsg");
  if (!match || !prop || !value) { msg.textContent = "Fill in the address, the property and the value."; return; }
  if (rules.some((r) => r.match.toLowerCase() === match.toLowerCase() && r.prop === prop && r.value === value)) { msg.textContent = "That rule already exists."; return; }
  rules.push({ id: Date.now().toString(36), match, prop, value });
  const n = items.filter((it) => [it.url, ...it.visits.map((v) => v.page)].some((u) => u && urlMatches(match, u))).length;
  msg.textContent = `Rule added. It matches ${n} item${n === 1 ? "" : "s"} you've already logged.`;
  $("#ruleMatch").value = ""; $("#ruleValue").value = "";
  saveRules();
};
$("#ruleUseTab").onclick = () => { $("#ruleMatch").value = suggestPattern(tabUrl); $("#ruleValue").focus(); };

async function showSettings() {
  const s = await getSettings();
  $("#updateSource").value = s.updateSource || "";
  $("#logListings").checked = !!s.logListings;
  $("#ruleUseTab").hidden = !tabUrl || !/^https?:/.test(tabUrl);
  renderRules();
  $("#versionLine").textContent = `You have FakeSale v${VERSION}.`;
  $("#ghLink").href = `https://github.com/${REPO}`;
  $("#errLink").href = ERROR_LIST_URL;
  setView("settings", "Settings");
}

// ---------- backup ----------

const doExport = guard("FS-402", async () => {
  const all = await getAllItems();
  const blob = new Blob([JSON.stringify({ app: "FakeSale", version: VERSION, exportedAt: new Date().toISOString(), rules, items: all }, null, 1)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `fakesale-backup-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  $("#dataResult").textContent = `Exported ${all.length} items.`;
});

const doImport = guard("FS-401", async (file) => {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { throw Object.assign(new Error(`Not JSON: ${e.message}`), { code: "FS-401" }); }
  if (data.app !== "FakeSale" || !Array.isArray(data.items)) throw Object.assign(new Error("Missing app/items fields"), { code: "FS-401" });
  let added = 0;
  for (const incoming of data.items) {
    if (!incoming.id || !Array.isArray(incoming.visits)) continue;
    const existing = await getItem(incoming.id);
    if (existing) {
      const seen = new Set(existing.visits.map((v) => v.t));
      existing.visits.push(...incoming.visits.filter((v) => !seen.has(v.t)));
      existing.visits.sort((a, b) => a.t - b.t);
      existing.firstSeen = Math.min(existing.firstSeen, incoming.firstSeen);
      existing.lastSeen = Math.max(existing.lastSeen, incoming.lastSeen);
      await putItem(existing);
    } else {
      await putItem(incoming);
      added++;
    }
  }
  for (const r of Array.isArray(data.rules) ? data.rules : []) {
    if (r && r.match && r.prop && r.value && !rules.some((x) => x.match === r.match && x.prop === r.prop && x.value === r.value)) {
      rules.push({ id: r.id || Date.now().toString(36) + rules.length, match: r.match, prop: r.prop, value: r.value });
    }
  }
  await saveSettings({ rules });
  renderRules();
  await rebuildAliases();
  items = await getAllItems();
  $("#dataResult").textContent = `Imported ${data.items.length} items (${added} new).`;
});

// ---------- wiring ----------

$("#list").addEventListener("click", (e) => { const li = e.target.closest(".item"); if (li) showDetail(li.dataset.id); });
$("#current").addEventListener("click", (e) => { const li = e.target.closest(".item"); if (li) showDetail(li.dataset.id); });
$("#back").onclick = showList;
$("#search").oninput = renderList;
$("#sort").onchange = renderList;
$("#propFilter").onchange = (e) => { propFilter = e.target.value; renderList(); };
$("#filters").onclick = (e) => {
  const b = e.target.closest(".chip"); if (!b) return;
  filter = b.dataset.f;
  document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c === b));
  renderList();
};
$("#openTab").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("app/app.html?full") });
$("#settingsBtn").onclick = showSettings;
$("#updateSource").onchange = guard("FS-302", (e) => saveSettings({ updateSource: e.target.value.trim() }));
$("#checkUpdates").onclick = guard("FS-999", async (e) => {
  e.target.textContent = "Checking for Updates…";
  const u = await chrome.runtime.sendMessage({ type: "checkUpdates" });
  e.target.textContent = "Check for Updates…";
  const out = $("#updateResult");
  out.innerHTML = "";
  if (u.error) out.append(errorBanner({ ...u.error, t: u.checkedAt }));
  else if (u.available) out.append(updateBanner(u));
  else out.textContent = `FakeSale is up to date (v${VERSION}).`;
});
$("#logListings").onchange = guard("FS-302", (e) => saveSettings({ logListings: e.target.checked }));
$("#clearPage").onclick = () => { pageIds = null; renderList(); };
$("#export").onclick = doExport;
$("#import").onclick = () => $("#importFile").click();
$("#importFile").onchange = (e) => e.target.files[0] && doImport(e.target.files[0]);

guard("FS-301", async () => {
  items = await getAllItems();
  rules = (await getSettings()).rules || [];
  if (!isFull) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    tabUrl = tab && tab.url; // available because opening the popup grants activeTab
  }
  renderPropFilter();
  await renderBanners();
  renderList();
  await renderCurrent();
})();
