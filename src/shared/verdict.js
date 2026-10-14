// Decides whether a "sale" is real, using only prices you've personally seen.
//
// The core test: a store shows "was $100, now $70". If, across your visits,
// you have never once seen it actually priced at $100, the "was" price is
// probably a fiction. The longer you've watched, the stronger that verdict.

const DAY = 864e5;
export const FAKE_AFTER_DAYS = 7;   // watched this long without seeing the "was" price -> fake
const MOVE = 0.03;                  // a 3% change counts as a real move

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function analyze(item) {
  const visits = item.visits || [];
  const last = visits[visits.length - 1];
  if (!last) return { kind: "new", label: "First look", text: "No visits recorded yet." };

  const prices = visits.map((v) => v.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const spanDays = (last.t - visits[0].t) / DAY;
  const claimed = last.original && last.original > last.price ? last.original : null;
  const claimedPct = claimed ? Math.round((1 - last.price / claimed) * 100) : 0;
  const earlier = visits.filter((v) => v.t < last.t - DAY / 24); // ignore same-hour reloads
  const typical = earlier.length ? median(earlier.map((v) => v.price)) : null;
  const sawClaimedAt = claimed ? visits.find((v) => v.price >= claimed * 0.99) : null;
  const daysWithClaim = claimed ? (last.t - (visits.find((v) => v.original) || last).t) / DAY : 0;
  const base = { low, high, typical, claimed, claimedPct, spanDays, visits: visits.length };
  const money = (n) => fmt(n, last.currency);
  const days = (d) => (d < 1 ? "less than a day" : `${Math.round(d)} day${Math.round(d) === 1 ? "" : "s"}`);

  if (claimed && sawClaimedAt) {
    return { ...base, kind: "real", label: "Real sale",
      text: `Claims ${claimedPct}% off ${money(claimed)}, and you did see it at ${money(sawClaimedAt.price)} on ${new Date(sawClaimedAt.t).toLocaleDateString()}.` };
  }
  if (claimed && spanDays >= FAKE_AFTER_DAYS) {
    const since = daysWithClaim >= spanDays - 0.5 ? `It has shown a "was" price on every visit.` : "";
    return { ...base, kind: "fake", label: "Fake sale",
      text: `Claims ${claimedPct}% off ${money(claimed)}, but in ${days(spanDays)} of tracking you've never seen it above ${money(high)}. ${since}`.trim() };
  }
  if (typical != null && last.price <= typical * (1 - MOVE)) {
    const pct = Math.round((1 - last.price / typical) * 100);
    return { ...base, kind: "real", label: "Real drop",
      text: `${pct}% below the ${money(typical)} you usually saw${claimed ? ` (the store's ${claimedPct}%-off claim is still unconfirmed)` : ""}.` };
  }
  if (typical != null && last.price >= typical * (1 + MOVE)) {
    const pct = Math.round((last.price / typical - 1) * 100);
    return { ...base, kind: "up", label: "Price up",
      text: `${pct}% above the ${money(typical)} you usually saw${claimed ? `, even though it still claims ${claimedPct}% off` : ""}.` };
  }
  if (claimed) {
    return { ...base, kind: "unverified", label: "Unverified",
      text: `Claims ${claimedPct}% off ${money(claimed)}. You've tracked it for ${days(spanDays)}; if it never reaches ${money(claimed)} within ${FAKE_AFTER_DAYS} days, FakeSale will call it fake.` };
  }
  if (earlier.length) {
    return { ...base, kind: "steady", label: "Steady", text: `Same price as your earlier visits (${money(typical)}).` };
  }
  return { ...base, kind: "new", label: "First look", text: "First visit. Come back later and FakeSale will compare." };
}

export function fmt(n, currency) {
  if (n == null) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD", currencyDisplay: "narrowSymbol" }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}
