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

// v1.2.3 repair: bad generic-reader sightings (badges, unit prices, carts) are dropped.
for (const k of Object.keys(mem)) delete mem[k];
const put = (it) => { mem["item:" + it.id] = it; mem["url:" + S.aliasKey(it.url)] = it.id; };
const amz = { id: "amazon.ca|B0X", host: "amazon.ca", url: "https://www.amazon.ca/x/dp/B000000001", name: "Coffee", firstSeen: 0, lastSeen: 1,
  visits: [{ t: 0, price: 0.96, source: "list:page", list: true, page: "https://www.amazon.ca/" }, { t: 1, price: 26.37, source: "amazon" }] };
const amzSearch = { id: "amazon.ca|B0Y", host: "amazon.ca", url: "https://www.amazon.ca/y/dp/B000000002", name: "Strings", firstSeen: 0, lastSeen: 0,
  visits: [{ t: 0, price: 8.99, source: "list:amazon", list: true, page: "https://www.amazon.ca/s?k=strings" }] };
const badge = { id: "shop.test|/p/1", host: "shop.test", url: "https://shop.test/p/1", name: "-5%", firstSeen: 0, lastSeen: 0,
  visits: [{ t: 0, price: 5, source: "list:page", list: true, page: "https://shop.test/sale" }] };
const cart = { id: "shop.test|/p/2", host: "shop.test", url: "https://shop.test/p/2", name: "Mug", firstSeen: 0, lastSeen: 1,
  visits: [{ t: 0, price: 9, source: "list:page", list: true, page: "https://shop.test/cart" }, { t: 1, price: 10, source: "list:page", list: true, page: "https://shop.test/sale" }] };
const fbGroup = { id: "facebook.com|/groups/x", host: "facebook.com", url: "https://www.facebook.com/groups/x/", name: "Details", firstSeen: 0, lastSeen: 0,
  visits: [{ t: 0, price: 3, source: "list:page", list: true, page: "https://www.facebook.com/marketplace/toronto/" }] };
const fbItem = { id: "facebook.com|/marketplace/item/1", host: "facebook.com", url: "https://www.facebook.com/marketplace/item/1/", name: "Amp", firstSeen: 0, lastSeen: 0,
  visits: [{ t: 0, price: 120, source: "list:page", list: true, page: "https://www.facebook.com/marketplace/toronto/" }] };
[amz, amzSearch, badge, cart, fbGroup, fbItem].forEach(put);
mem.migrations = ["1.2.1-generic-list"];
assert.equal(await S.dropBadGridVisits(), 4);
assert.deepEqual(mem["item:" + amz.id].visits.map((v) => v.price), [26.37]);
assert.equal(mem["item:" + amz.id].firstSeen, 1);
assert.equal(mem["item:" + amzSearch.id].visits.length, 1);
assert.ok(!("item:" + badge.id in mem) && !Object.values(mem).includes(badge.id));
assert.deepEqual(mem["item:" + cart.id].visits.map((v) => v.price), [10]);
assert.ok(!("item:" + fbGroup.id in mem));
assert.equal(mem["item:" + fbItem.id].visits.length, 1);
assert.deepEqual(mem.migrations, ["1.2.1-generic-list", "1.2.3-bad-grid"]);
assert.equal(await S.dropBadGridVisits(), 0); // runs once

// The content script's copy of PRIVATE_PAGE must match storage.js's.
const privateRe = (code) => code.match(/const PRIVATE_PAGE = (\/.*\/i);/)[1];
assert.equal(privateRe(src), privateRe(readFileSync(new URL("../src/shared/storage.js", import.meta.url), "utf8")));
console.log("v1.2.3 repair migration tests passed.");

// Grid reader: unit prices and savings aren't the price; badges aren't names.
const notThePrice = new Function(src.match(/  function notThePrice[\s\S]*?\n  }\n/)[0] + "return notThePrice;")();
const no = [
  ["$0.28", ["$0.28$0.28", "($0.28$0.28/count)"]],   // Amazon unit price
  ["$1.20/100 g", []],
  ["Save $20", []],
  ["$20", ["Save $20"]],
  ["$20 off", []],
  ["$4.99", ["($4.99 per item)"]],
];
for (const [own, around] of no) assert.equal(notThePrice(own, around), true, own);
const yes = [
  ["$179.99", ["$179.99 Save $20", "$179.99 Save $20 Blueair humidifier"]],
  ["$53.99", ["-5% $53.99"]],
  ["$99.99", ["Price $99.99"]],
  ["$1,299.00", []],
];
for (const [own, around] of yes) assert.equal(notThePrice(own, around), false, own);
const BADGE = new Function("return " + src.match(/const BADGE = (\/.*\/i);/)[1])();
for (const s of ["-5%", "-10% off", "new offers", "3 new offers", "Sale", "Best Seller", "Save $20"]) assert.ok(BADGE.test(s), s);
for (const s of ["BOSS TU-3 Chromatic Tuner", "Salesforce Mug", "10% Juice Box"]) assert.ok(!BADGE.test(s), s);
console.log("Grid reader price and name tests passed.");
