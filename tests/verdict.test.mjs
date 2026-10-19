// Run: node tests/verdict.test.mjs
import assert from "node:assert/strict";
import { analyze } from "../src/shared/verdict.js";
import { addVisit, newItem } from "../src/shared/storage.js";
import { readFileSync } from "node:fs";

const D = 864e5, T0 = Date.UTC(2026, 0, 1);
const obs = (price, original = null) => ({ host: "shop.test", url: "https://shop.test/p/1", name: "Thing", price, original, currency: "USD", source: "test" });
const build = (seq) => { const it = newItem(obs(1), T0); seq.forEach(([day, p, o]) => addVisit(it, obs(p, o), T0 + day * D)); return it; };

assert.equal(analyze(build([[0, 50]])).kind, "new");
assert.equal(analyze(build([[0, 70, 100]])).kind, "unverified");
assert.equal(analyze(build([[0, 70, 100], [3, 70, 100], [9, 70, 100]])).kind, "fake");
assert.equal(analyze(build([[0, 100], [5, 100], [9, 70, 100]])).kind, "real");
assert.equal(analyze(build([[0, 50], [5, 50], [9, 40]])).kind, "real");
assert.equal(analyze(build([[0, 50], [5, 50], [9, 60]])).kind, "up");
assert.equal(analyze(build([[0, 50], [5, 50]])).kind, "steady");
// reloads within 30 minutes fold into one visit
const it = build([[0, 50], [0.01, 50], [0.02, 50]]);
assert.equal(it.visits.length, 1); assert.equal(it.visits[0].n, 3);

// price parser lives in the content script; pull it out without a DOM
const src = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
const parsePrice = new Function(src.match(/function parsePrice[\s\S]*?\n  }\n/)[0] + "return parsePrice;")();
for (const [input, want] of [["$1,299.99", 1299.99], ["1.299,99 €", 1299.99], ["CA$ 49", 49], ["1 299,99", 1299.99], ["£12.5", 12.5], ["1,299", 1299], [19.99, 19.99], ["Free", null], ["$0.00", null], ["-5% $53.99", 53.99], ["-10%", null], ["Save 20% $80", 80]]) {
  assert.equal(parsePrice(input), want, `parsePrice(${JSON.stringify(input)})`);
}
console.log("All verdict and price-parsing tests passed.");
