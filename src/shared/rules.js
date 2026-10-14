// Property rules: "anything whose web address starts with X has property
// Y = Z", e.g. everything under long-mcquade.com/GearHunter/ is Condition:
// Used. Rules are applied when items are shown, not when they're saved, so a
// new or edited rule instantly covers everything already in your history.
//
// rule -> { id, match, prop, value }

const norm = (s) => String(s || "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

// Prefix match that ignores http/https and "www.". "*" matches anything,
// e.g. "amazon.*/renewed".
export function urlMatches(pattern, url) {
  const p = norm(pattern);
  if (!p || !url) return false;
  return new RegExp("^" + p.split("*").map(escapeRe).join(".*"), "i").test(norm(url));
}

// The addresses an item has been seen at: its own page, plus any list pages.
export const itemUrls = (item) => [item.url, ...new Set((item.visits || []).map((v) => v.page).filter(Boolean))];

export function propsFor(item, rules = []) {
  const props = {};
  if (item.condition) props.Condition = item.condition; // published by the store
  const urls = itemUrls(item);
  for (const r of rules) {
    if (r.prop && r.value && urls.some((u) => urlMatches(r.match, u))) props[r.prop.trim()] = r.value.trim();
  }
  return props;
}

// schema.org itemCondition -> a plain word.
export function conditionFrom(raw) {
  const s = String(raw || "").toLowerCase();
  if (!s) return null;
  if (s.includes("refurb")) return "Refurbished";
  if (s.includes("used")) return "Used";
  if (s.includes("damaged")) return "Damaged";
  if (s.includes("new")) return "New";
  return null;
}

// A starting pattern for "add a rule for this page": the site plus the
// first folder of the path, e.g. long-mcquade.com/GearHunter/.
export function suggestPattern(url) {
  try {
    const u = new URL(url);
    const first = u.pathname.split("/").filter(Boolean)[0];
    return u.hostname.replace(/^www\./, "") + "/" + (first ? first + "/" : "");
  } catch { return ""; }
}
