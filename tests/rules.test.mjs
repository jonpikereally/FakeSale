// Run: node tests/rules.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { urlMatches, propsFor, conditionFrom, suggestPattern } from "../src/shared/rules.js";

const gh = "long-mcquade.com/GearHunter/";
assert.ok(urlMatches(gh, "https://www.long-mcquade.com/GearHunter/1150282/TC-Electronic-QUINTESSENCE.htm"));
assert.ok(urlMatches("https://www.long-mcquade.com/GearHunter/", "http://long-mcquade.com/gearhunter/guitars/"));
assert.ok(!urlMatches(gh, "https://www.long-mcquade.com/1150282/TC-Electronic.htm"));
assert.ok(urlMatches("amazon.*/renewed", "https://www.amazon.ca/renewed/thing"));
assert.ok(!urlMatches("", "https://x.test/"));

const rules = [{ match: gh, prop: "Condition", value: "Used" }, { match: "shop.test/outlet", prop: "Store", value: "Outlet" }];
// Matches on the item's own address...
assert.deepEqual(propsFor({ url: "https://www.long-mcquade.com/GearHunter/1/x.htm", visits: [] }, rules), { Condition: "Used" });
// ...or on a list page it was seen on.
assert.deepEqual(propsFor({ url: "https://shop.test/p/9", visits: [{ page: "https://shop.test/outlet/shoes" }] }, rules), { Store: "Outlet" });
// A rule beats the store's own published condition.
assert.deepEqual(propsFor({ url: "https://www.long-mcquade.com/GearHunter/1/x.htm", condition: "New", visits: [] }, rules), { Condition: "Used" });
assert.deepEqual(propsFor({ url: "https://other.test/a", condition: "Refurbished", visits: [] }, rules), { Condition: "Refurbished" });

assert.equal(conditionFrom("https://schema.org/UsedCondition"), "Used");
assert.equal(conditionFrom("RefurbishedCondition"), "Refurbished");
assert.equal(conditionFrom("NewCondition"), "New");
assert.equal(suggestPattern("https://www.long-mcquade.com/GearHunter/guitars/?x=1"), "long-mcquade.com/GearHunter/");

// content.js keeps its own copy of the condition mapping; keep them in step.
const src = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
const contentCondition = new Function(src.match(/  function condition\(raw\)[\s\S]*?\n  }\n/)[0] + "return condition;")();
for (const c of ["UsedCondition", "RefurbishedCondition", "NewCondition", "DamagedCondition", "", "weird"]) assert.equal(contentCondition(c), conditionFrom(c), c);

// Financing amounts aren't prices; labelled "regular" prices are "was" prices.
const FIN = new Function(src.match(/  const FINANCING = .*\n/)[0] + "return FINANCING;")();
const WAS = new Function(src.match(/  const WAS_LABEL = .*\n/)[0] + "return WAS_LABEL;")();
for (const t of ["or from: $24.00/mo", "$10 / month", "4 payments of $12.50", "$30 per month"]) assert.ok(FIN.test(t), t);
for (const t of ["Sale Price: $163.00", "$172.00", "Save $40"]) assert.ok(!FIN.test(t), t);
for (const t of ["Regular Price: $172.00", "Reg. $50", "Was $20", "Compare at $99", "MSRP $300"]) assert.ok(WAS.test(t), t);
for (const t of ["Sale Price: $163.00", "$5.99", "Now $10"]) assert.ok(!WAS.test(t), t);
console.log("All rules tests passed.");
