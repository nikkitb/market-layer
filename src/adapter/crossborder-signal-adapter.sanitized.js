/**
 * Sanitized representative extraction
 * Source: SHOPER_APP_ANALYTICS/storefront-module/crossborder-signal-adapter.js
 *
 * This file demonstrates the real normalization, routing, consent, and
 * delivery patterns used in the production adapter. Production values
 * (measurement IDs, pixel IDs, endpoint URLs, market hostnames) have been
 * replaced with synthetic placeholders. Private customer data handling,
 * PII extraction, and full state model are omitted for brevity and safety.
 *
 * This is NOT the complete production adapter.
 */

const MARKET_KEYS = Object.freeze(["pl", "de", "en"]);

const CONFIG_ENDPOINT =
  "https://example.marketlayer.workers.dev/v1/config";

const TRANSPORT = {
  endpoint: "https://example.marketlayer.workers.dev/v1/events",
  browserGa4: true,
  browserGoogleAds: true,
  browserMeta: true,
  serverGa4: false,
  serverGoogleAds: false,
  serverMeta: false,
};

const state = {
  version: "0.7.0-sanitized",
  market: { hostname: "", pathname: "", language: "" },
  routing: { status: "unmatched", marketKey: null, measurementId: null, evidence: {} },
  events: [],
  normalizedEvents: [],
  ga4: { measurementId: null, marketKey: null, mode: "test", deliveries: [], serverDeliveries: [] },
  googleAds: { accountId: null, deliveries: [] },
  meta: { browserDeliveries: [], serverDeliveries: [] },
  consent: { ready: false, analytics: false, marketing: false, updatedAt: null },
};

let MARKETS = Object.freeze({});
let googleTagReady = null;
let metaReady = null;

/* =========================================================
 * REMOTE CONFIG
 * ======================================================= */

const requestJson = (url) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.timeout = 5000;
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        return reject(new Error(`config-http-${xhr.status}`));
      }
      try { resolve(JSON.parse(xhr.responseText)); }
      catch { reject(new Error("config-invalid-json")); }
    };
    xhr.onerror = () => reject(new Error("config-network-error"));
    xhr.ontimeout = () => reject(new Error("config-timeout"));
    xhr.send();
  });

const configReady = requestJson(CONFIG_ENDPOINT)
  .then((payload) => {
    if (!payload?.config?.markets) return false;
    MARKETS = Object.freeze(
      Object.fromEntries(
        MARKET_KEYS.map((key) => {
          const saved = payload.config.markets[key];
          return [
            key,
            {
              hostnames: saved?.enabled && saved?.hostname ? [saved.hostname] : [],
              language: saved?.language || "",
              ga4MeasurementId: saved?.ga4?.measurementId || null,
              metaPixelId: saved?.meta?.pixelId || null,
              googleAdsId: saved?.googleAds?.conversionId || null,
            },
          ];
        })
      )
    );
    return true;
  })
  .catch(() => false);

/* =========================================================
 * MARKET ROUTING
 * ======================================================= */

const currentMarket = () => ({
  hostname: window.location.hostname,
  pathname: window.location.pathname,
  language: (document.documentElement.lang || "").toLowerCase(),
});

const resolveRouting = () => {
  const evidence = currentMarket();
  const matches = Object.entries(MARKETS).filter(
    ([, market]) =>
      market.hostnames.includes(evidence.hostname) &&
      market.language === evidence.language
  );

  if (matches.length !== 1) {
    return {
      status: matches.length > 1 ? "ambiguous" : "unmatched",
      marketKey: null,
      measurementId: null,
      evidence,
    };
  }

  const [marketKey, market] = matches[0];
  return { status: "matched", marketKey, measurementId: market.ga4MeasurementId, evidence };
};

/* =========================================================
 * EVENT IDENTITY
 * ======================================================= */

const createEventId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
};

/* =========================================================
 * NORMALIZER (representative subset)
 * ======================================================= */

const normalize = (eventName, source, payload, receivedAt) => {
  const body = payload?.body || payload || {};
  const items = (Array.isArray(body.items) ? body.items : []).map((item) => ({
    item_id: String(item.id ?? item.productId ?? ""),
    item_name: String(item.name ?? ""),
    item_brand: String(item.producer?.name ?? item.producer ?? ""),
    item_category: String(item.category?.name ?? item.category ?? ""),
    price: Number(item.price?.grossValue ?? item.price ?? 0),
    quantity: Number(item.quantity || 1),
  }));

  const currency = String(
    body.basket?.sumToPay?.currency ??
      body.basket?.sum?.currency ??
      items[0]?.currency ??
      ""
  );

  const value =
    Number(body.basket?.sumToPay?.grossValue ??
      body.basket?.sum?.grossValue ??
      0) ||
    items.reduce((sum, item) => sum + item.price * item.quantity, 0);

  const result = {
    shoperEvent: eventName,
    canonicalEvent: null,
    receivedAt,
    source,
    market: { ...currentMarket(), pathname: source === "event-bus" ? window.location.pathname : null },
    ga4: null,
    googleAds: null,
    meta: null,
  };

  // Representative mapping: analytics.addedToBasket -> cart.item_added
  if (eventName === "analytics.addedToBasket") {
    result.canonicalEvent = "cart.item_added";
    result.ga4 = { event: "add_to_cart", params: { currency, value, items } };
    result.googleAds = { event: "add_to_cart", params: result.ga4.params };
    result.meta = {
      event_name: "AddToCart",
      custom_data: { currency, value, content_type: "product", content_ids: items.map((i) => i.item_id), contents: items.map((i) => ({ id: i.item_id, quantity: i.quantity, item_price: i.price })) },
    };
  }

  // Representative mapping: analytics.purchased -> order.purchased
  if (eventName === "analytics.purchased") {
    const transactionId = String(body.orderId ?? "");
    result.canonicalEvent = "order.purchased";
    result.ga4 = { event: "purchase", params: { transaction_id: transactionId, currency, value, items } };
    result.googleAds = { event: "purchase", params: result.ga4.params };
    result.meta = {
      event_name: "Purchase",
      event_id: transactionId ? `purchase_${transactionId}` : null,
      custom_data: { currency, value, content_type: "product", content_ids: items.map((i) => i.item_id), contents: items.map((i) => ({ id: i.item_id, quantity: i.quantity, item_price: i.price })), num_items: items.reduce((sum, i) => sum + i.quantity, 0) },
    };
  }

  return result.canonicalEvent ? result : null;
};

/* =========================================================
 * CONSENT
 * ======================================================= */

const updateConsentState = () => {
  // In production, reads Shoper Customer Privacy API
  // This is a simplified demonstration
  state.consent.ready = true;
  state.consent.analytics = true;
  state.consent.marketing = true;
  state.consent.updatedAt = new Date().toISOString();
  syncGoogleConsentMode();
};

const canSendAnalytics = () => state.consent.ready && state.consent.analytics === true;
const canSendMarketing = () => state.consent.ready && state.consent.marketing === true;

const syncGoogleConsentMode = () => {
  if (typeof window.crossborderGtag !== "function") return;
  window.crossborderGtag("consent", "update", {
    analytics_storage: state.consent.analytics ? "granted" : "denied",
    ad_storage: state.consent.marketing ? "granted" : "denied",
    ad_user_data: state.consent.marketing ? "granted" : "denied",
    ad_personalization: state.consent.marketing ? "granted" : "denied",
  });
};

/* =========================================================
 * DELIVERY LOGGERS
 * ======================================================= */

const noteDelivery = (target, entry) => {
  target.push(entry);
  if (target.length > 100) target.shift();
};

/* =========================================================
 * GA4 BROWSER DELIVERY
 * ======================================================= */

const sentPurchases = new Set();

const sendGa4 = async (normalized) => {
  if (!normalized?.ga4) return;
  if (TRANSPORT.browserGa4 && normalized.source === "event-bus") {
    const routing = resolveRouting();
    if (routing.status !== "matched") return noteDelivery(state.ga4.deliveries, { event: normalized.ga4.event, status: "skipped", reason: `routing-${routing.status}` });
    if (!canSendAnalytics()) return noteDelivery(state.ga4.deliveries, { event: normalized.ga4.event, status: "skipped", reason: "consent-denied" });

    const transactionId = normalized.ga4.params?.transaction_id;
    if (normalized.ga4.event === "purchase" && transactionId) {
      if (sentPurchases.has(transactionId)) return noteDelivery(state.ga4.deliveries, { event: normalized.ga4.event, status: "skipped", reason: "duplicate-purchase" });
      sentPurchases.add(transactionId);
    }

    try {
      await ensureGoogleTag(routing);
      window.crossborderGtag("event", normalized.ga4.event, { ...normalized.ga4.params, send_to: routing.measurementId, debug_mode: true });
      noteDelivery(state.ga4.deliveries, { event: normalized.ga4.event, transactionId, status: "queued" });
    } catch (error) {
      if (transactionId) sentPurchases.delete(transactionId);
      noteDelivery(state.ga4.deliveries, { event: normalized.ga4.event, status: "failed", reason: error.message });
    }
  }
};

/* =========================================================
 * GOOGLE ADS BROWSER DELIVERY
 * ======================================================= */

const sendGoogleAds = async (normalized) => {
  if (!normalized?.googleAds) return;
  if (TRANSPORT.browserGoogleAds && normalized.source === "event-bus") {
    const routing = resolveRouting();
    if (routing.status !== "matched") return;
    if (!canSendMarketing()) return noteDelivery(state.googleAds.deliveries, { event: normalized.googleAds.event, status: "skipped", reason: "consent-denied" });

    // ... ensure Google Ads configured ...
    window.crossborderGtag("event", "conversion", { send_to: "AW-XXXXXXX/LABEL", value: normalized.googleAds.params.value, currency: normalized.googleAds.params.currency, transaction_id: normalized.googleAds.params.transaction_id });
    noteDelivery(state.googleAds.deliveries, { event: normalized.googleAds.event, action: "purchase", status: "queued" });
  }
};

/* =========================================================
 * META BROWSER DELIVERY
 * ======================================================= */

const sendMetaPixel = async (normalized) => {
  if (!normalized?.meta) return;
  if (TRANSPORT.browserMeta && normalized.source === "event-bus") {
    const routing = resolveRouting();
    if (routing.status !== "matched") return;
    if (!canSendMarketing()) return noteDelivery(state.meta.browserDeliveries, { event: normalized.meta.event_name, status: "skipped", reason: "consent-denied" });

    await ensureMetaPixel(routing);
    window.fbq("track", normalized.meta.event_name, normalized.meta.custom_data, { eventID: normalized.meta.event_id });
    noteDelivery(state.meta.browserDeliveries, { event: normalized.meta.event_name, eventId: normalized.meta.event_id, status: "queued" });
  }
};

/* =========================================================
 * SERVER ENVELOPE DISPATCH
 * ======================================================= */

const sendServer = async (normalized) => {
  if (!normalized?.ga4 && !normalized?.meta) return;
  if (normalized.source !== "event-bus") return;
  if (!TRANSPORT.endpoint) return;

  const routing = resolveRouting();
  if (routing.status !== "matched") return;

  // Build consent block for server envelope
  const consent = {
    analytics_storage: state.consent.analytics ? "granted" : "denied",
    ad_storage: state.consent.marketing ? "granted" : "denied",
    ad_user_data: state.consent.marketing ? "granted" : "denied",
    ad_personalization: state.consent.marketing ? "granted" : "denied",
  };

  const envelope = {
    eventId: normalized.eventId,
    market: normalized.market,
    consent,
    ga4: normalized.ga4,
    meta: normalized.meta,
    pageUrl: window.location.href,
  };

  try {
    const response = await fetch(TRANSPORT.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    const status = response.ok ? "sent" : "failed";
    if (normalized.ga4) noteDelivery(state.ga4.serverDeliveries, { event: normalized.ga4.event, status, reason: response.ok ? null : `http-${response.status}` });
    if (normalized.meta) noteDelivery(state.meta.serverDeliveries, { event: normalized.meta.event_name, status, reason: response.ok ? null : `http-${response.status}` });
  } catch (error) {
    if (normalized.ga4) noteDelivery(state.ga4.serverDeliveries, { event: normalized.ga4.event, status: "failed", reason: error.message });
    if (normalized.meta) noteDelivery(state.meta.serverDeliveries, { event: normalized.meta.event_name, status: "failed", reason: error.message });
  }
};

/* =========================================================
 * DISPATCH
 * ======================================================= */

const dispatchNormalized = (normalized) => {
  if (!normalized) return;
  void sendGa4(normalized);
  void sendGoogleAds(normalized);
  void sendMetaPixel(normalized);
  void sendServer(normalized);
};

/* =========================================================
 * PUBLIC API
 * ======================================================= */

window.__crossborderSignalAdapter = Object.freeze({
  version: state.version,
  inspect() { return JSON.parse(JSON.stringify(state)); },
  refreshConsent() { updateConsentState(); return JSON.parse(JSON.stringify(state.consent)); },
});
