// Run: node tests/listing.test.mjs
// Checks that an item seen in a grid and on its own page share one history.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mem = {};
globalThis.chrome = { storage: { local: {
  get: async (k) => k == null ? { ...mem } : Object.fromEntries([].concat(k).filter((x) => x in mem).map((x) => [x, mem[x]])),
  set: async (o) => Object.assign(mem, o),
  remove: async (k) => [].concat(k).forEach((x) => delete mem[x]),
} } };
const S = await import("../src/shared/storage.js");

// content.js has its own copy of aliasKey; it must behave identically.
const src = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
const block = src.slice(src.indexOf("  const ID_PARAMS"), src.indexOf("  const TRACKING"));
const fn = src.match(/  function aliasKey[\s\S]*?\n  }\n/)[0];
const contentAlias = new Function("location", block + fn + "return aliasKey;")({ href: "https://x.test/" });
const urls = [
  "https://www.shop.test/collections/sale/products/blue-shirt?utm_source=x",
  "https://shop.test/products/Blue-Shirt/",
  "https://oldnavy.gap.com/browse/product.do?pid=285492052&cid=1185226&pcid=3&vid=1",
  "https://www.amazon.ca/Ninja-Thing/dp/B0CS3V8M9H/ref=sr_1_4?th=1",
  "https://shop.test/products/x?variant=123&color=red",
];
for (const u of urls) assert.equal(contentAlias(u), S.aliasKey(u), u);
assert.equal(S.aliasKey(urls[0]), S.aliasKey(urls[1]));
assert.equal(S.aliasKey(urls[2]), "oldnavy.gap.com/browse/product.do?pid=285492052");
assert.equal(S.aliasKey(urls[3]), "amazon.ca/dp/b0cs3v8m9h");

const record = async (obs, t) => {
  obs.alias = S.aliasKey(obs.url);
  const item = S.addVisit((await S.findItem(obs)) || S.newItem(obs, t), obs, t);
  await S.saveItemWithAlias(item, obs.alias);
  return item;
};
const D = 864e5;
// Grid first (no sku), then the product page (with a sku): same item.
await record({ host: "oldnavy.gap.com", url: urls[2], name: "Leggings", price: 6, original: 9.99, source: "list:page" }, 0);
const it = await record({ host: "oldnavy.gap.com", url: "https://oldnavy.gap.com/browse/product.do?pid=285492052", sku: "285492052", name: "Ruffle-Trim Leggings for Baby", price: 6, original: 9.99, source: "json-ld" }, D);
assert.equal((await S.getAllItems()).length, 1);
assert.equal(it.visits.length, 2);
assert.equal(it.visits[0].list, true);
assert.equal(it.visits[1].list, undefined);
assert.equal(it.name, "Ruffle-Trim Leggings for Baby");

// Product page first, then a grid with a shorter name: name and URL are kept.
const p = await record({ host: "shop.test", url: urls[1], sku: "BS-1", name: "Blue Shirt (Large)", price: 20, source: "shopify" }, 0);
const g = await record({ host: "shop.test", url: urls[0], sku: "BS-1", name: "Blue Shirt", price: 18, original: 25, source: "list:shopify" }, D);
assert.equal(p.id, g.id);
assert.equal(g.name, "Blue Shirt (Large)");

// Deleting an item removes its aliases too.
await S.deleteItem(g.id);
assert.ok(!Object.values(mem).includes(g.id));

// Items saved by v1.0.0 (no aliases) are found after the upgrade.
const old = { id: "legacy.test|/item/9", host: "legacy.test", url: "https://legacy.test/item/9", name: "Old", firstSeen: 0, lastSeen: 0, visits: [{ t: 0, price: 5 }] };
mem["item:" + old.id] = old;
await S.rebuildAliases();
const again = await record({ host: "legacy.test", url: "https://legacy.test/item/9?ref=abc", sku: "SKU9", name: "Old", price: 5, source: "list:page" }, D);
assert.equal(again.id, old.id);
console.log("All listing and matching tests passed.");

// v1.2.1 repair: v1.1 generic-reader grid sightings are dropped, others kept.
for (const k of Object.keys(mem)) delete mem[k];
const lm = { id: "long-mcquade.com|/gearhunter/935664/x.htm", host: "long-mcquade.com", url: "https://www.long-mcquade.com/GearHunter/935664/x.htm", firstSeen: 0, lastSeen: 0,
  visits: [{ t: 0, price: 267, source: "list:page", list: true }] };
const mixed = { id: "shop.test|SKU", host: "shop.test", url: "https://shop.test/p", firstSeen: 0, lastSeen: 2,
  visits: [{ t: 0, price: 5, source: "list:page", list: true }, { t: 1, price: 9, source: "json-ld" }, { t: 2, price: 8, source: "list:page", list: true, page: "https://shop.test/sale" }] };
Object.assign(mem, { ["item:" + lm.id]: lm, ["url:long-mcquade.com/gearhunter/935664/x.htm"]: lm.id, ["item:" + mixed.id]: mixed });
assert.equal(await S.dropV11GenericListVisits(), 2);
assert.ok(!("item:" + lm.id in mem) && !Object.values(mem).includes(lm.id));
assert.deepEqual(mem["item:" + mixed.id].visits.map((v) => v.price), [9, 8]);
assert.equal(mem["item:" + mixed.id].firstSeen, 1);
assert.equal(await S.dropV11GenericListVisits(), 0); // runs once
console.log("Repair migration tests passed.");
