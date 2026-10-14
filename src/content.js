// FakeSale content script: runs on every page, decides whether it is a
// product page, and if so reports the price (and any "was" price) to the
// background worker. It never reads form fields or anything you type.
(() => {
  if (window.__fakeSale) return;

  const RETRY_DELAYS = [1200, 3500, 8000];

  // ---------- price parsing ----------

  const CURRENCY_SYMBOLS = [
    ["CA$", "CAD"], ["C$", "CAD"], ["US$", "USD"], ["A$", "AUD"], ["AU$", "AUD"],
    ["NZ$", "NZD"], ["HK$", "HKD"], ["R$", "BRL"], ["MX$", "MXN"],
    ["€", "EUR"], ["£", "GBP"], ["¥", "JPY"], ["₹", "INR"], ["₩", "KRW"],
    ["CHF", "CHF"], ["kr", "SEK"], ["zł", "PLN"], ["$", null],
  ];

  function detectCurrency(text) {
    const iso = text.match(/\b(USD|CAD|EUR|GBP|AUD|NZD|JPY|INR|CHF|SEK|NOK|DKK|PLN|MXN|BRL|HKD|KRW)\b/);
    if (iso) return iso[1];
    for (const [sym, code] of CURRENCY_SYMBOLS) if (text.includes(sym)) return code;
    return null;
  }

  // "$1,299.99" -> 1299.99, "1.299,99 €" -> 1299.99, "1 299,99" -> 1299.99
  function parsePrice(raw) {
    if (raw == null) return null;
    if (typeof raw === "number") return isFinite(raw) && raw > 0 ? raw : null;
    let s = String(raw).replace(/ /g, " ").trim();
    const m = s.match(/\d[\d.,\s']*/);
    if (!m) return null;
    s = m[0].replace(/[\s']/g, "").replace(/[.,]$/, "");
    const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
    const sep = Math.max(lastDot, lastComma);
    if (sep !== -1) {
      const decimals = s.length - sep - 1;
      const bothUsed = lastDot !== -1 && lastComma !== -1;
      if (bothUsed || decimals !== 3) {
        s = s.slice(0, sep).replace(/[.,]/g, "") + "." + s.slice(sep + 1);
      } else {
        s = s.replace(/[.,]/g, ""); // "1,299" or "1.299" -> thousands
      }
    }
    const n = parseFloat(s);
    return isFinite(n) && n > 0 && n < 1e7 ? Math.round(n * 100) / 100 : null;
  }

  // ---------- helpers ----------

  const $ = (sel, root = document) => root.querySelector(sel);
  const meta = (...names) => {
    for (const n of names) {
      const el = document.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
      if (el && el.content) return el.content.trim();
    }
    return null;
  };
  const text = (el) => (el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "");
  const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
  const typeIs = (node, t) => asArray(node && node["@type"]).some((x) => String(x).toLowerCase() === t.toLowerCase());

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  }

  // ---------- source 1: JSON-LD (schema.org Product) ----------

  function* walk(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 8) return;
    if (Array.isArray(node)) { for (const n of node) yield* walk(n, depth + 1); return; }
    yield node;
    for (const k of ["@graph", "mainEntity", "itemListElement", "hasVariant", "item"]) {
      if (node[k]) yield* walk(node[k], depth + 1);
    }
  }

  function offerPrices(offer) {
    let price = parsePrice(offer.price ?? offer.lowPrice);
    let original = null;
    let currency = offer.priceCurrency || null;
    for (const spec of asArray(offer.priceSpecification)) {
      const p = parsePrice(spec.price);
      const kind = String(spec.priceType || "").toLowerCase();
      if (/strikethrough|listprice|msrp|srp/.test(kind)) original = p;
      else if (price == null) price = p;
      currency = currency || spec.priceCurrency || null;
    }
    return { price, original, currency };
  }

  function fromJsonLd() {
    const here = location.href.split("#")[0];
    const variantId = new URL(location.href).searchParams.get("variant");
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try { data = JSON.parse(script.textContent); } catch { continue; }
      for (const node of walk(data)) {
        if (!typeIs(node, "Product") && !typeIs(node, "ProductGroup")) continue;
        let offers = asArray(node.offers).flatMap((o) => (typeIs(o, "AggregateOffer") && o.offers ? asArray(o.offers).concat(o) : [o]));
        if (!offers.length && node.hasVariant) {
          offers = asArray(node.hasVariant).flatMap((v) => asArray(v.offers).map((o) => ({ ...o, url: o.url || v.url })));
        }
        if (!offers.length) continue;
        const pick =
          offers.find((o) => o.url && (o.url === here || (variantId && String(o.url).includes(variantId)))) ||
          offers.find((o) => /InStock/i.test(String(o.availability || "")) && parsePrice(o.price ?? o.lowPrice)) ||
          offers.find((o) => parsePrice(o.price ?? o.lowPrice));
        if (!pick) continue;
        const { price, original, currency } = offerPrices(pick);
        if (!price) continue;
        return {
          source: "json-ld",
          name: node.name,
          sku: node.sku || node.productID || node.mpn || node.gtin13 || node.gtin12 || null,
          image: asArray(node.image).map((i) => (typeof i === "string" ? i : i && i.url)).find(Boolean) || null,
          price, original, currency,
        };
      }
    }
    return null;
  }

  // ---------- source 2: microdata ----------

  function fromMicrodata() {
    const scope = $('[itemtype*="schema.org/Product" i]');
    if (!scope) return null;
    const priceEl = $('[itemprop="price"], [itemprop="lowPrice"]', scope);
    if (!priceEl) return null;
    const price = parsePrice(priceEl.getAttribute("content") || text(priceEl));
    if (!price) return null;
    const cur = $('[itemprop="priceCurrency"]', scope);
    const img = $('[itemprop="image"]', scope);
    return {
      source: "microdata",
      name: text($('[itemprop="name"]', scope)) || null,
      sku: ($('[itemprop="sku"]', scope) || {}).content || text($('[itemprop="sku"]', scope)) || null,
      image: img ? img.getAttribute("content") || img.src || img.href : null,
      price,
      original: null,
      currency: cur ? cur.getAttribute("content") || text(cur) : null,
    };
  }

  // ---------- source 3: Open Graph product meta ----------

  function fromMeta() {
    const ogType = (meta("og:type") || "").toLowerCase();
    const amount = meta("product:sale_price:amount", "product:price:amount", "og:price:amount");
    if (!amount || (ogType && !ogType.includes("product"))) return null;
    const price = parsePrice(amount);
    if (!price) return null;
    const saleExists = !!meta("product:sale_price:amount");
    const original = parsePrice(
      meta("product:original_price:amount", "og:price:standard_amount") || (saleExists ? meta("product:price:amount") : null)
    );
    return {
      source: "meta",
      name: meta("og:title") || null,
      sku: meta("product:retailer_item_id") || null,
      image: meta("og:image") || null,
      price,
      original: original && original !== price ? original : null,
      currency: meta("product:sale_price:currency", "product:price:currency", "og:price:currency"),
    };
  }

  // ---------- source 4: Amazon (no structured price data) ----------

  function fromAmazon() {
    if (!/(^|\.)amazon\.[a-z.]+$/.test(location.hostname)) return null;
    const title = text($("#productTitle"));
    if (!title) return null;
    const pick = (sels) => {
      for (const s of sels) {
        const el = $(s);
        const p = el && parsePrice(text(el));
        if (p) return { p, raw: text(el) };
      }
      return null;
    };
    const now = pick([
      "#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen",
      "#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen",
      "#apex_desktop .apexPriceToPay .a-offscreen",
      "#price_inside_buybox",
      "#priceblock_dealprice", "#priceblock_ourprice",
      "#corePrice_desktop .a-price .a-offscreen",
    ]);
    if (!now) return null;
    const was = pick([
      "#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen",
      "#corePriceDisplay_desktop_feature_div .a-text-price[data-a-strike] .a-offscreen",
      "#corePrice_desktop .a-text-price[data-a-strike] .a-offscreen",
      "#apex_desktop .basisPrice .a-offscreen",
      "#listPrice", "#priceblock_listprice",
    ]);
    const asin = (location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/) || [])[1] || ($("#ASIN") || {}).value || null;
    const img = $("#landingImage") || $("#imgBlkFront");
    return {
      source: "amazon",
      name: title,
      sku: asin,
      image: img ? img.getAttribute("data-old-hires") || img.src : null,
      price: now.p,
      original: was && was.p > now.p ? was.p : null,
      currency: detectCurrency(now.raw) || meta("og:price:currency"),
      canonical: asin ? `${location.origin}/dp/${asin}` : null,
    };
  }

  // ---------- source 5: Shopify product JSON (has compare_at_price) ----------

  async function fromShopify() {
    const isShopify = !!(document.querySelector('link[href*="cdn.shopify.com"], script[src*="cdn.shopify.com"], meta[name="shopify-digital-wallet"]'));
    const m = location.pathname.match(/^(.*\/products\/[^/?#]+)/);
    if (!isShopify || !m) return null;
    const res = await fetch(`${location.origin}${m[1]}.js`, { credentials: "same-origin" });
    if (!res.ok) return null;
    const product = await res.json();
    const variantId = new URL(location.href).searchParams.get("variant");
    const v = (product.variants || []).find((x) => String(x.id) === variantId) || (product.variants || [])[0];
    if (!v) return null;
    const price = v.price / 100;
    const original = v.compare_at_price ? v.compare_at_price / 100 : null;
    return {
      source: "shopify",
      name: product.title + (v.title && v.title !== "Default Title" ? ` (${v.title})` : ""),
      sku: v.sku || String(v.id),
      image: (v.featured_image && v.featured_image.src) || product.featured_image || null,
      price,
      original: original && original > price ? original : null,
      currency: meta("og:price:currency", "product:price:currency"),
    };
  }

  // ---------- generic "was" price: a struck-through price next to the real one ----------

  const WAS_CLASS = /(compare|was|orig|regular|list|strike|before|old|rrp|msrp)[-_ ]?(at[-_ ]?)?price|price[-_ ]?(was|old|regular|compare|before|original|strike)|crossed|strikethrough/i;

  function looksStruck(el) {
    if (["S", "DEL", "STRIKE"].includes(el.tagName)) return true;
    const cls = `${el.className && el.className.baseVal != null ? el.className.baseVal : el.className} ${el.id}`;
    if (WAS_CLASS.test(cls)) return true;
    return getComputedStyle(el).textDecorationLine.includes("line-through");
  }

  // Find the visible element that shows the current price (biggest text wins),
  // then look nearby for a struck-through higher price. Searching only near the
  // main price keeps "related products" carousels from leaking in.
  function findNearbyOriginal(price) {
    const candidates = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let count = 0;
    for (let el = walker.nextNode(); el && count < 15000; el = walker.nextNode(), count++) {
      if (el.children.length > 2) continue;
      const t = text(el);
      if (t.length > 40 || !/\d/.test(t)) continue;
      if (parsePrice(t) === price && isVisible(el)) candidates.push(el);
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => parseFloat(getComputedStyle(b).fontSize) - parseFloat(getComputedStyle(a).fontSize));
    let box = candidates[0];
    for (let depth = 0; depth < 5 && box; depth++, box = box.parentElement) {
      for (const el of box.querySelectorAll("*")) {
        const t = text(el);
        if (!t || t.length > 40 || el.children.length > 2) continue;
        const p = parsePrice(t);
        if (p && p > price && p <= price * 10 && looksStruck(el) && isVisible(el)) return p;
      }
    }
    return null;
  }

  // ---------- canonical URL ----------

  const TRACKING = /^(utm_|fbclid|gclid|dclid|msclkid|mc_|_ga|_gl|igshid|ref$|ref_|refRID|pd_rd|pf_rd|psc$|th$|tag$|spm|scm|sr$|qid$|keywords$|crid$|sprefix$|srsltid|campaign|cmp|cid$|clickid|irclickid|affiliate)/i;

  function canonicalUrl(found) {
    if (found.canonical) return found.canonical;
    const link = $('link[rel="canonical"]');
    let raw = location.href;
    if (link && link.href && new URL(link.href, location.href).hostname === location.hostname) {
      // Keep the page's own variant selector if the canonical dropped it.
      const variant = new URL(location.href).searchParams.get("variant");
      raw = link.href;
      if (variant && !raw.includes("variant=")) raw += (raw.includes("?") ? "&" : "?") + "variant=" + variant;
    }
    const u = new URL(raw, location.href);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    return u.toString();
  }

  // ---------- main ----------

  async function detect() {
    let found = fromAmazon() || fromJsonLd() || fromMicrodata() || fromMeta();
    let shop = null;
    try { shop = await fromShopify(); } catch { /* not a Shopify product page */ }
    if (shop) {
      found = found ? { ...found, ...shop, name: found.name || shop.name, image: found.image || shop.image, currency: found.currency || shop.currency } : shop;
    }
    if (!found || !found.price) return null;
    if (!found.original) {
      try { found.original = findNearbyOriginal(found.price); } catch { /* best effort */ }
    }
    if (found.original && found.original <= found.price) found.original = null;
    if (!found.currency) found.currency = detectCurrency(document.title) || null;
    return {
      url: canonicalUrl(found),
      pageUrl: location.href.split("#")[0],
      host: location.hostname.replace(/^www\./, ""),
      name: (found.name || document.title || "").trim().slice(0, 300),
      sku: found.sku ? String(found.sku).slice(0, 100) : null,
      image: found.image ? new URL(found.image, location.href).toString() : null,
      price: found.price,
      original: found.original || null,
      currency: found.currency ? String(found.currency).toUpperCase().slice(0, 3) : null,
      source: found.source,
    };
  }

  let runId = 0;
  function scan() {
    const id = ++runId;
    const url = location.href;
    let i = 0;
    const attempt = async () => {
      if (id !== runId || url !== location.href) return;
      let obs = null;
      try { obs = await detect(); } catch (e) {
        chrome.runtime.sendMessage({ type: "error", code: "FS-201", details: String(e && e.stack || e) }).catch(() => {});
      }
      if (obs) {
        chrome.runtime.sendMessage({ type: "observation", data: obs }).catch(() => {});
      } else if (i < RETRY_DELAYS.length - 1) {
        setTimeout(attempt, RETRY_DELAYS[++i] - RETRY_DELAYS[i - 1]);
      }
    };
    setTimeout(attempt, RETRY_DELAYS[0]);
  }

  // Exposed for testing in a page console; harmless otherwise.
  window.__fakeSale = { detect, parsePrice };

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
    scan();
    // Single-page shops change the URL without reloading: re-scan on change.
    let last = location.href;
    setInterval(() => {
      if (location.href !== last) { last = location.href; scan(); }
    }, 1000);
  }
})();
