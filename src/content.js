// FakeSale content script: runs on every page. On a single product page it
// reports that product's price (and any "was" price). On a search, category
// or collection page it can report every item in the grid, if "Log items on
// listing pages" is switched on in Settings. It never reads form fields or
// anything you type.
(() => {
  if (window.__fakeSale) return;

  const RETRY_DELAYS = [1200, 3500, 8000];
  const MAX_LIST_ITEMS = 300;

  // ---------- price parsing ----------

  const CURRENCY_SYMBOLS = [
    ["CA$", "CAD"], ["C$", "CAD"], ["US$", "USD"], ["A$", "AUD"], ["AU$", "AUD"],
    ["NZ$", "NZD"], ["HK$", "HKD"], ["R$", "BRL"], ["MX$", "MXN"],
    ["€", "EUR"], ["£", "GBP"], ["¥", "JPY"], ["₹", "INR"], ["₩", "KRW"],
    ["CHF", "CHF"], ["kr", "SEK"], ["zł", "PLN"], ["$", null],
  ];
  const MONEY = /[$€£¥₹₩]|\b(USD|CAD|EUR|GBP|AUD|CHF)\b/;

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
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
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
  const isAmazon = () => /(^|\.)amazon\.[a-z.]+$/.test(location.hostname);
  const isShopify = () => !!$('link[href*="cdn.shopify.com"], script[src*="cdn.shopify.com"], meta[name="shopify-digital-wallet"]');
  const abs = (u) => { try { return new URL(u, location.href).toString(); } catch { return null; } };

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  }

  function jsonLdBlocks() {
    const out = [];
    for (const script of $$('script[type="application/ld+json"]')) {
      try { out.push(JSON.parse(script.textContent)); } catch { /* skip broken blocks */ }
    }
    return out;
  }

  // Walks JSON-LD. With lists=false it never enters an ItemList, so a
  // category page's grid can't be mistaken for one product.
  function* walk(node, lists, depth = 0) {
    if (!node || typeof node !== "object" || depth > 8) return;
    if (Array.isArray(node)) { for (const n of node) yield* walk(n, lists, depth + 1); return; }
    yield node;
    if (!lists && (typeIs(node, "ItemList") || typeIs(node, "BreadcrumbList") || typeIs(node, "OfferCatalog"))) return;
    const keys = lists ? ["@graph", "mainEntity", "itemListElement", "item", "hasVariant"] : ["@graph", "mainEntity", "hasVariant"];
    for (const k of keys) if (node[k]) yield* walk(node[k], lists, depth + 1);
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

  function productOffers(node) {
    let offers = asArray(node.offers).flatMap((o) => (typeIs(o, "AggregateOffer") && o.offers ? asArray(o.offers).concat(o) : [o]));
    if (!offers.length && node.hasVariant) {
      offers = asArray(node.hasVariant).flatMap((v) => asArray(v.offers).map((o) => ({ ...o, url: o.url || v.url })));
    }
    return offers;
  }

  const firstImage = (node) => asArray(node.image).map((i) => (typeof i === "string" ? i : i && i.url)).find(Boolean) || null;
  const skuOf = (node) => node.sku || node.productID || node.mpn || node.gtin13 || node.gtin12 || null;

  // ---------- identity: the same product seen in a grid and on its own page ----------

  // Query parameters that identify a product (kept); everything else, like
  // tracking or the category you came from, is dropped.
  const ID_PARAMS = /^(variant|pid|productid|product_id|prodid|sku|skuid|itemid|item_id|id)$/i;
  const TRACKING = /^(utm_|fbclid|gclid|dclid|msclkid|mc_|_ga|_gl|igshid|ref$|ref_|refRID|pd_rd|pf_rd|psc$|th$|tag$|spm|scm|sr$|qid$|keywords$|crid$|sprefix$|srsltid|campaign|cmp|cid$|clickid|irclickid|affiliate|dib)/i;

  // A stable key used to match a grid item to its product page.
  function aliasKey(raw) {
    const u = new URL(raw, location.href);
    const host = u.hostname.replace(/^www\./, "");
    let path = u.pathname.replace(/\/collections\/[^/]+(\/products\/)/i, "$1").replace(/\/+$/, "").toLowerCase();
    const asin = path.match(/\/(?:dp|gp\/product)\/([a-z0-9]{10})/);
    if (asin && /(^|\.)amazon\./.test(host)) path = `/dp/${asin[1]}`;
    const keep = [...u.searchParams].filter(([k]) => ID_PARAMS.test(k)).map(([k, v]) => `${k.toLowerCase()}=${v}`).sort();
    return host + path + (keep.length ? "?" + keep.join("&") : "");
  }

  function cleanUrl(raw) {
    const u = new URL(raw, location.href);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    u.pathname = u.pathname.replace(/\/collections\/[^/]+(\/products\/)/i, "$1");
    return u.toString();
  }

  function finish(found, url) {
    if (found.original && found.original <= found.price) found.original = null;
    return {
      url: cleanUrl(url),
      alias: aliasKey(url),
      host: location.hostname.replace(/^www\./, ""),
      name: String(found.name || "").replace(/\s+/g, " ").trim().slice(0, 300),
      sku: found.sku ? String(found.sku).slice(0, 100) : null,
      image: found.image ? abs(found.image) : null,
      price: found.price,
      original: found.original || null,
      currency: found.currency ? String(found.currency).toUpperCase().slice(0, 3) : null,
      source: found.source,
    };
  }

  // =====================================================================
  // Single product pages
  // =====================================================================

  function fromJsonLd() {
    const here = location.href.split("#")[0];
    const variantId = new URL(location.href).searchParams.get("variant");
    for (const data of jsonLdBlocks()) {
      for (const node of walk(data, false)) {
        if (!typeIs(node, "Product") && !typeIs(node, "ProductGroup")) continue;
        const offers = productOffers(node);
        if (!offers.length) continue;
        const pick =
          offers.find((o) => o.url && (o.url === here || (variantId && String(o.url).includes(variantId)))) ||
          offers.find((o) => /InStock/i.test(String(o.availability || "")) && parsePrice(o.price ?? o.lowPrice)) ||
          offers.find((o) => parsePrice(o.price ?? o.lowPrice));
        if (!pick) continue;
        const { price, original, currency } = offerPrices(pick);
        if (!price) continue;
        return { source: "json-ld", name: node.name, sku: skuOf(node), image: firstImage(node), price, original, currency };
      }
    }
    return null;
  }

  // Product microdata scopes that aren't nested inside another product.
  const productScopes = () =>
    $$('[itemtype*="schema.org/Product" i]').filter((el) => !el.parentElement || !el.parentElement.closest('[itemtype*="schema.org/Product" i]'));

  function microdataProduct(scope) {
    const priceEl = $('[itemprop="price"], [itemprop="lowPrice"]', scope);
    if (!priceEl) return null;
    const price = parsePrice(priceEl.getAttribute("content") || text(priceEl));
    if (!price) return null;
    const cur = $('[itemprop="priceCurrency"]', scope);
    const img = $('[itemprop="image"]', scope);
    const skuEl = $('[itemprop="sku"]', scope);
    return {
      source: "microdata",
      name: (($('[itemprop="name"]', scope) || {}).content) || text($('[itemprop="name"]', scope)) || null,
      sku: skuEl ? skuEl.getAttribute("content") || text(skuEl) : null,
      image: img ? img.getAttribute("content") || img.src || img.href : null,
      price,
      original: null,
      currency: cur ? cur.getAttribute("content") || text(cur) : null,
    };
  }

  function fromMicrodata() {
    const scopes = productScopes();
    return scopes.length === 1 ? microdataProduct(scopes[0]) : null;
  }

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

  function fromAmazon() {
    if (!isAmazon()) return null;
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

  // Shopify variants carry compare_at_price, the store's own "was" price.
  function shopifyVariant(product, variantId, inCents) {
    const v = (product.variants || []).find((x) => String(x.id) === variantId) || (product.variants || [])[0];
    if (!v) return null;
    const money = (x) => (x == null || x === "" ? null : inCents ? x / 100 : parsePrice(x));
    const price = money(v.price);
    const original = money(v.compare_at_price);
    if (!price) return null;
    const img = (v.featured_image && v.featured_image.src) || product.featured_image || (product.images && product.images[0] && (product.images[0].src || product.images[0])) || null;
    return {
      source: "shopify",
      name: product.title + (v.title && v.title !== "Default Title" ? ` (${v.title})` : ""),
      sku: v.sku || String(v.id),
      image: img,
      price,
      original: original && original > price ? original : null,
      currency: meta("og:price:currency", "product:price:currency"),
    };
  }

  async function fromShopify() {
    const m = location.pathname.match(/^(.*\/products\/[^/?#]+)/);
    if (!isShopify() || !m) return null;
    const res = await fetch(`${location.origin}${m[1]}.js`, { credentials: "same-origin" });
    if (!res.ok) return null;
    return shopifyVariant(await res.json(), new URL(location.href).searchParams.get("variant"), true);
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

  function pageCanonical(found) {
    if (found.canonical) return found.canonical;
    const link = $('link[rel="canonical"]');
    let raw = location.href;
    if (link && link.href && new URL(link.href, location.href).hostname === location.hostname) {
      // Keep the page's own variant selector if the canonical dropped it.
      const variant = new URL(location.href).searchParams.get("variant");
      raw = link.href;
      if (variant && !raw.includes("variant=")) raw += (raw.includes("?") ? "&" : "?") + "variant=" + variant;
    }
    return raw;
  }

  async function detectProduct() {
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
    if (!found.currency) found.currency = detectCurrency(document.title) || null;
    return finish(found, pageCanonical(found));
  }

  // =====================================================================
  // Listing pages (search results, categories, collections)
  // =====================================================================

  function listFromJsonLd() {
    const out = [];
    for (const data of jsonLdBlocks()) {
      for (const node of walk(data, true)) {
        if (!typeIs(node, "ItemList")) continue;
        for (const el of asArray(node.itemListElement)) {
          const p = el && (el.item && typeof el.item === "object" ? el.item : el);
          if (!p || (!typeIs(p, "Product") && !typeIs(p, "ProductGroup"))) continue;
          const offer = productOffers(p).find((o) => parsePrice(o.price ?? o.lowPrice) || o.priceSpecification);
          if (!offer) continue;
          const { price, original, currency } = offerPrices(offer);
          const url = p.url || offer.url || el.url;
          if (!price || !url) continue;
          out.push(finish({ source: "list:json-ld", name: p.name, sku: skuOf(p), image: firstImage(p), price, original, currency }, url));
        }
      }
    }
    return out;
  }

  function listFromMicrodata() {
    const scopes = productScopes();
    if (scopes.length < 2) return [];
    return scopes.map((scope) => {
      const found = microdataProduct(scope);
      const urlEl = $('[itemprop="url"]', scope) || $("a[href]", scope);
      const url = urlEl && (urlEl.getAttribute("content") || urlEl.href);
      if (!found || !url) return null;
      found.original = cardOriginal(scope, found.price);
      found.source = "list:microdata";
      return finish(found, url);
    }).filter(Boolean);
  }

  function listFromAmazon() {
    if (!isAmazon()) return [];
    return $$('[data-component-type="s-search-result"][data-asin]').map((card) => {
      const asin = card.getAttribute("data-asin");
      const nowEl = $(".a-price:not(.a-text-price) .a-offscreen", card);
      const price = nowEl && parsePrice(text(nowEl));
      if (!asin || !price) return null;
      const was = Math.max(0, ...$$(".a-price.a-text-price .a-offscreen", card).map((e) => parsePrice(text(e)) || 0));
      const h2 = $("h2", card);
      const img = $("img.s-image", card);
      return finish({
        source: "list:amazon",
        name: ((h2 && (h2.getAttribute("aria-label") || text(h2))) || (img && img.alt) || "").replace(/^Sponsored( Ad)?\s*[-–—:]\s*/i, ""),
        sku: asin,
        image: img && img.src,
        price,
        original: was > price ? was : null,
        currency: detectCurrency(text(nowEl)),
      }, `${location.origin}/dp/${asin}`);
    }).filter(Boolean);
  }

  async function listFromShopify() {
    if (!isShopify()) return [];
    const handles = [...new Set($$('a[href*="/products/"]').map((a) => {
      try {
        const u = new URL(a.href);
        return u.hostname === location.hostname ? (u.pathname.match(/\/products\/([^/?#.]+)/) || [])[1] : null;
      } catch { return null; }
    }).filter(Boolean))].slice(0, MAX_LIST_ITEMS);
    if (handles.length < 2) return [];
    const toObs = (product, inCents) => {
      const found = shopifyVariant(product, null, inCents);
      if (!found) return null;
      found.source = "list:shopify";
      return finish(found, `${location.origin}/products/${product.handle}`);
    };
    // A collection page: one request returns every product with its prices.
    const coll = location.pathname.match(/\/collections\/([^/]+)\/?$/);
    if (coll) {
      const res = await fetch(`${location.origin}/collections/${coll[1]}/products.json?limit=250`, { credentials: "same-origin" });
      if (res.ok) {
        const wanted = new Set(handles);
        const { products = [] } = await res.json();
        const got = products.filter((p) => wanted.has(p.handle)).map((p) => toObs(p, false)).filter(Boolean);
        if (got.length) return got;
      }
    }
    // Search results, home page, etc.: ask for each product (4 at a time, max 48).
    const out = [];
    const queue = handles.slice(0, 48);
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length) {
        const h = queue.shift();
        try {
          const res = await fetch(`${location.origin}/products/${h}.js`, { credentials: "same-origin" });
          if (res.ok) { const o = toObs(await res.json(), true); if (o) out.push(o); }
        } catch { /* skip this one */ }
      }
    }));
    return out;
  }

  // The highest struck-through price inside a product card, if any.
  function cardOriginal(card, price) {
    let best = null;
    for (const el of card.querySelectorAll("*")) {
      if (el.children.length > 2) continue;
      const t = text(el);
      if (!t || t.length > 30 || !/\d/.test(t)) continue;
      const p = parsePrice(t);
      if (p && p > price && p <= price * 10 && (looksStruck(el) || (el.parentElement && looksStruck(el.parentElement))) && (!best || p > best)) best = p;
    }
    return best;
  }

  // Any store: find price labels, grow each into the biggest box that still
  // links to exactly one page (the product card), then read the card.
  function listFromDom() {
    const linkOf = (a) => {
      try {
        const u = new URL(a.getAttribute("href"), location.href);
        return /^https?:$/.test(u.protocol) && u.hostname.replace(/^www\./, "") === location.hostname.replace(/^www\./, "") && u.pathname.length > 1 ? cleanUrl(u) : null;
      } catch { return null; }
    };
    const priceEls = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let count = 0;
    for (let el = walker.nextNode(); el && count < 20000; el = walker.nextNode(), count++) {
      if (el.children.length > 2 || ["SCRIPT", "STYLE", "OPTION", "INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) continue;
      const t = text(el);
      if (t.length > 30 || !MONEY.test(t) || !/\d/.test(t)) continue;
      priceEls.push(el);
    }
    const cards = new Map();
    for (const el of priceEls) {
      let card = null, link = null;
      for (let node = el.parentElement, depth = 0; node && node !== document.body && depth < 8; node = node.parentElement, depth++) {
        const links = new Set($$("a[href]", node).map(linkOf).filter(Boolean));
        if (node.tagName === "A") { const own = linkOf(node); if (own) links.add(own); }
        if (links.size > 1 || text(node).length > 600) break;
        if (links.size === 1) { card = node; link = [...links][0]; }
      }
      if (card && !cards.has(card)) cards.set(card, link);
    }
    // Drop cards nested inside other cards.
    const list = [...cards].filter(([c]) => ![...cards.keys()].some((o) => o !== c && o.contains(c)));
    if (list.length < 3) return [];
    const out = [];
    for (const [card, url] of list) {
      if (!isVisible(card)) continue;
      const prices = [];
      for (const el of card.querySelectorAll("*")) {
        if (el.children.length > 2) continue;
        const t = text(el);
        if (t.length > 30 || !MONEY.test(t)) continue;
        const p = parsePrice(t);
        if (p) prices.push({ p, struck: looksStruck(el) || (el.parentElement !== card && looksStruck(el.parentElement)), t });
      }
      const live = prices.filter((x) => !x.struck).map((x) => x.p);
      if (!live.length) continue;
      const price = Math.min(...live);
      const struck = prices.filter((x) => x.struck && x.p > price && x.p <= price * 10).map((x) => x.p);
      const img = $("img", card);
      const named = $$("a[href]", card).map((a) => a.getAttribute("aria-label") || a.title || text(a)).filter((s) => s && !MONEY.test(s)).sort((a, b) => b.length - a.length)[0];
      const name = text($("h2, h3, h4, [class*='title' i], [class*='name' i]", card)) || named || (img && img.alt);
      if (!name) continue;
      out.push(finish({
        source: "list:page",
        name,
        image: img && (img.currentSrc || img.src),
        price,
        original: struck.length ? Math.max(...struck) : null,
        currency: detectCurrency((prices.find((x) => x.p === price) || {}).t || "") || meta("og:price:currency"),
      }, url));
    }
    return out;
  }

  async function detectListing() {
    let items = listFromAmazon();
    if (!items.length) items = await listFromShopify().catch(() => []);
    if (!items.length) items = listFromJsonLd();
    if (!items.length) items = listFromMicrodata();
    if (!items.length) items = listFromDom();
    const seen = new Set();
    return items.filter((o) => o.price && !seen.has(o.alias) && seen.add(o.alias)).slice(0, MAX_LIST_ITEMS);
  }

  // =====================================================================
  // Running it
  // =====================================================================

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});
  const reportError = (code, e) => send({ type: "error", code, details: `${e && e.stack || e}\nPage: ${location.hostname}` });

  async function listingsEnabled() {
    try {
      const { settings = {} } = await chrome.storage.local.get("settings");
      return !!settings.logListings;
    } catch { return false; }
  }

  let runId = 0;
  let observer = null;

  function scan() {
    const id = ++runId;
    const url = location.href;
    if (observer) { observer.disconnect(); observer = null; }
    const sentAliases = new Set();
    let i = 0;

    const scanListing = async () => {
      if (id !== runId || url !== location.href) return 0;
      let items = [];
      try { items = await detectListing(); } catch (e) { reportError("FS-203", e); return 0; }
      const fresh = items.filter((o) => !sentAliases.has(o.alias));
      fresh.forEach((o) => sentAliases.add(o.alias));
      if (fresh.length) send({ type: "listing", data: fresh });
      return items.length;
    };

    const attempt = async () => {
      if (id !== runId || url !== location.href) return;
      let obs = null;
      try { obs = await detectProduct(); } catch (e) { reportError("FS-201", e); }
      if (obs) return send({ type: "observation", data: obs });
      if (await listingsEnabled()) {
        const n = await scanListing();
        if (n && !observer) {
          // Infinite scroll and "load more": rescan when the grid grows.
          let timer = null;
          observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => { if (sentAliases.size < MAX_LIST_ITEMS) scanListing(); }, 2500);
          });
          observer.observe(document.body, { childList: true, subtree: true });
        }
        if (n) return;
      }
      if (i < RETRY_DELAYS.length - 1) setTimeout(attempt, RETRY_DELAYS[++i] - RETRY_DELAYS[i - 1]);
    };
    setTimeout(attempt, RETRY_DELAYS[0]);
  }

  // Exposed for testing in a page console; harmless otherwise.
  window.__fakeSale = { detect: detectProduct, detectListing, parsePrice, aliasKey };

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
    scan();
    // Single-page shops change the URL without reloading: re-scan on change.
    let last = location.href;
    setInterval(() => {
      if (location.href !== last) { last = location.href; scan(); }
    }, 1000);
  }
})();
