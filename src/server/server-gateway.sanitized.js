/**
 * Sanitized representative extraction
 * Source: SHOPER_APP_ANALYTICS/src/server-tracking.js
 *
 * Demonstrates the real Worker-side envelope validation, market resolution,
 * D1 deduplication, and destination delivery logic. Production secrets,
 * real measurement IDs, and pixel IDs have been replaced with placeholders.
 *
 * This is NOT the complete production server-tracking module.
 */

import { decryptSecret, readConfig } from "./config-store.js";
import { defaultConfig } from "./market-defaults.js";

const ALLOWED_EVENTS = new Set([
  "select_item", "remove_from_cart", "page_view", "view_item", "view_item_list",
  "view_search_results", "add_to_wishlist", "view_cart", "add_shipping_info",
  "add_payment_info", "add_to_cart", "begin_checkout", "purchase",
]);

const ALLOWED_META_EVENTS = new Set([
  "PageView", "ViewContent", "ViewCategory", "Search", "AddToCart",
  "AddToWishlist", "InitiateCheckout", "AddPaymentInfo", "Purchase",
]);

function toRuntimeMarketConfig(config) {
  return Object.fromEntries(
    Object.entries(config.markets || {})
      .filter(([, market]) => market.enabled && market.hostname && market.language)
      .map(([key, market]) => [
        key,
        {
          hostnames: [market.hostname],
          language: market.language.split(/[-_]/)[0],
          destinations: {
            ga4: { measurementId: market.ga4?.measurementId || "", server: Boolean(market.ga4?.serverEnabled) },
            googleAds: { conversionId: market.googleAds?.conversionId || "", purchaseLabel: market.googleAds?.purchaseLabel || "", server: Boolean(market.googleAds?.serverEnabled) },
            meta: { pixelId: market.meta?.pixelId || "", server: Boolean(market.meta?.serverEnabled) },
          },
        },
      ])
  );
}

const MARKET_CONFIG = Object.freeze(toRuntimeMarketConfig(defaultConfig()));

/* =========================================================
 * VALIDATION HELPERS
 * =============================================================== */

const cleanString = (value, max = 256) => (typeof value === "string" ? value.slice(0, max) : "");
const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);

function originHostname(origin) {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" ? parsed.hostname.toLowerCase() : "";
  } catch {
    return "";
  }
}

function isAllowedOrigin(origin, config = MARKET_CONFIG) {
  const hostname = originHostname(origin);
  return Boolean(hostname) && Object.values(config).some((market) => market.hostnames.includes(hostname));
}

async function runtimeMarketConfig(env) {
  return toRuntimeMarketConfig(await readConfig(env));
}

/* =========================================================
 * MARKET RESOLUTION
 * =============================================================== */

function resolveMarket(payload, origin, config = MARKET_CONFIG) {
  const hostname = cleanString(payload?.market?.hostname, 253).toLowerCase();
  const language = cleanString(payload?.market?.language, 12).toLowerCase().split(/[-_]/)[0];
  const requestHostname = originHostname(origin);
  const matches = Object.entries(config).filter(
    ([, market]) => market.hostnames.includes(hostname) && hostname === requestHostname && market.language === language
  );
  if (matches.length !== 1) return null;
  const [key, marketConfig] = matches[0];
  return { key, ...marketConfig };
}

/* =========================================================
 * ENVELOPE VALIDATION
 * =============================================================== */

function validateEnvelope(payload) {
  if (!isRecord(payload) || !isRecord(payload.market) || !isRecord(payload.consent)) return "invalid_envelope";
  if (!isRecord(payload.ga4) && !isRecord(payload.meta)) return "missing_destination_payload";
  if (!cleanString(payload.eventId, 128)) return "missing_event_id";
  if (payload.ga4 && (!ALLOWED_EVENTS.has(payload.ga4.event) || !isRecord(payload.ga4.params))) return "invalid_ga4_event";
  if (payload.meta && (!ALLOWED_META_EVENTS.has(cleanString(payload.meta.event_name, 64)) || !isRecord(payload.meta.custom_data))) return "invalid_meta_event";
  return null;
}

/* =========================================================
 * D1 DEDUPLICATION
 * =============================================================== */

async function claimEvent(env, marketKey, eventId) {
  if (!env.EVENTS_DB) return { claimed: true, durable: false };
  const key = `${marketKey}:${eventId}`;
  const result = await env.EVENTS_DB.prepare(
    "INSERT OR IGNORE INTO event_claims (event_key, created_at) VALUES (?, ?)"
  ).bind(key, new Date().toISOString()).run();
  return { claimed: Number(result?.meta?.changes || 0) === 1, durable: true, key };
}

async function releaseEvent(env, key) {
  if (env.EVENTS_DB && key) {
    await env.EVENTS_DB.prepare("DELETE FROM event_claims WHERE event_key = ?").bind(key).run();
  }
}

/* =========================================================
 * PII HASHING (Meta)
 * =============================================================== */

const normalizeEmail = (value) => value.trim().toLowerCase();
const normalizePhone = (value) => value.replace(/[^\d]/g, "");
const normalizeExternalId = (value) => value.trim().toLowerCase();
const normalizeName = (value) => value.trim().toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const normalizeLocation = (value) => value.trim().toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const normalizeCountry = (value) => value.trim().toLowerCase().replace(/[^a-z]/g, "");

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashValues(value, normalizer) {
  const hashes = [];
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (typeof entry !== "string") continue;
    const normalized = normalizer(entry);
    if (!normalized) continue;
    hashes.push(/^[a-f0-9]{64}$/i.test(normalized) ? normalized.toLowerCase() : await sha256(normalized));
  }
  return hashes;
}

async function buildMetaUserData(payload) {
  const input = isRecord(payload.meta?.user_data) ? payload.meta.user_data : {};
  const output = {};
  const em = await hashValues(input.em ?? input.email, normalizeEmail);
  const ph = await hashValues(input.ph ?? input.phone, normalizePhone);
  const externalId = await hashValues(input.external_id ?? input.externalId, normalizeExternalId);
  const fn = await hashValues(input.fn ?? input.firstName, normalizeName);
  const ln = await hashValues(input.ln ?? input.lastName, normalizeName);
  const ct = await hashValues(input.ct ?? input.city, normalizeLocation);
  const st = await hashValues(input.st ?? input.state, normalizeLocation);
  const zp = await hashValues(input.zp ?? input.postalCode, normalizeLocation);
  const country = await hashValues(input.country ?? input.countryCode, normalizeCountry);
  if (em.length) output.em = em;
  if (ph.length) output.ph = ph;
  if (externalId.length) output.external_id = externalId;
  if (fn.length) output.fn = fn;
  if (ln.length) output.ln = ln;
  if (ct.length) output.ct = ct;
  if (st.length) output.st = st;
  if (zp.length) output.zp = zp;
  if (country.length) output.country = country;
  const fbp = cleanString(payload.fbp ?? input.fbp ?? input._fbp, 256);
  const fbc = cleanString(payload.fbc ?? input.fbc ?? input._fbc, 256);
  if (fbp) output.fbp = fbp;
  if (fbc) output.fbc = fbc;
  return output;
}

/* =========================================================
 * DESTINATION DELIVERY
 * =============================================================== */

function secretFor(env, prefix, marketKey) {
  return env[`${prefix}_${marketKey.toUpperCase()}`];
}

async function sendGa4(env, market, payload) {
  if (payload.consent.analytics_storage !== "granted") return { destination: "ga4", status: "skipped", reason: "consent" };
  if (!payload.ga4) return { destination: "ga4", status: "skipped", reason: "no_event" };
  const apiSecret = secretFor(env, "GA4_API_SECRET", market.key);
  if (!apiSecret) return { destination: "ga4", status: "skipped", reason: "not_configured" };
  const endpoint = new URL("https://region1.google-analytics.com/mp/collect");
  endpoint.searchParams.set("measurement_id", market.destinations.ga4.measurementId);
  endpoint.searchParams.set("api_secret", apiSecret);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: cleanString(payload.clientId, 128) || crypto.randomUUID(),
      timestamp_micros: String(Date.now() * 1000),
      events: [{ name: payload.ga4.event, params: { ...payload.ga4.params, event_id: payload.eventId } }],
    }),
  });
  return { destination: "ga4", status: response.ok ? "sent" : "failed", httpStatus: response.status };
}

async function sendMeta(env, market, payload) {
  if (payload.consent.ad_storage !== "granted" || payload.consent.ad_user_data !== "granted") {
    return { destination: "meta", status: "skipped", reason: "consent" };
  }
  if (!payload.meta) return { destination: "meta", status: "skipped", reason: "no_event" };
  const savedConfig = await readConfig(env);
  const savedMeta = savedConfig.updatedAt ? savedConfig.markets?.[market.key]?.meta : null;
  if (savedMeta?.serverEnabled === false) return { destination: "meta", status: "skipped", reason: "market_server_disabled" };
  const pixelId = savedMeta?.pixelId || secretFor(env, "META_PIXEL_ID", market.key) || market.destinations.meta.pixelId;
  let token = savedMeta ? "" : secretFor(env, "META_ACCESS_TOKEN", market.key);
  if (savedMeta?.accessTokenEncrypted) {
    try { token = await decryptSecret(env, savedMeta.accessTokenEncrypted); }
    catch { return { destination: "meta", status: "failed", reason: "secret_decryption_failed" }; }
  }
  const userData = await buildMetaUserData(payload);
  const graphVersion = /^v\d+\.\d+$/.test(env.META_GRAPH_VERSION || "") ? env.META_GRAPH_VERSION : "v23.0";
  const endpoint = new URL(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(pixelId)}/events`);
  endpoint.searchParams.set("access_token", token);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      data: [{
        event_name: payload.meta.event_name,
        event_time: Math.floor(Date.now() / 1000),
        event_id: payload.eventId,
        action_source: "website",
        event_source_url: cleanString(payload.pageUrl, 2048),
        user_data: userData,
        custom_data: payload.meta.custom_data,
      }],
    }),
  });
  return { destination: "meta", status: response.ok ? "sent" : "failed", httpStatus: response.status };
}

/* =========================================================
 * MAIN HANDLER
 * =============================================================== */

export async function handleTrackingRequest(request, env, requestId) {
  const origin = request.headers.get("origin") || "";
  const marketConfig = await runtimeMarketConfig(env);

  if (request.method === "OPTIONS") {
    return isAllowedOrigin(origin, marketConfig)
      ? new Response(null, { status: 204, headers: corsHeaders(origin) })
      : json({ ok: false, error: "origin_forbidden" }, 403);
  }
  if (!isAllowedOrigin(origin, marketConfig)) return json({ ok: false, error: "origin_forbidden", request_id: requestId }, 403);

  let payload;
  try { payload = await readLimitedJson(request); }
  catch (error) {
    const code = error instanceof Error ? error.message : "invalid_json";
    return json({ ok: false, error: code, request_id: requestId }, code === "payload_too_large" ? 413 : 400, corsHeaders(origin));
  }

  const validationError = validateEnvelope(payload);
  if (validationError) return json({ ok: false, error: validationError, request_id: requestId }, 400, corsHeaders(origin));

  let market;
  try { market = resolveMarket(payload, origin, marketConfig); } catch { market = null; }
  if (!market) return json({ ok: false, error: "market_mismatch", request_id: requestId }, 403, corsHeaders(origin));

  const claim = await claimEvent(env, market.key, payload.eventId);
  if (!claim.claimed) {
    return json({ ok: true, duplicate: true, market: market.key, event_id: payload.eventId, request_id: requestId }, 202, corsHeaders(origin));
  }

  const deliveries = await Promise.all([sendGa4(env, market, payload), sendMeta(env, market, payload)]);
  const deliveryFailed = deliveries.some((delivery) => delivery.status === "failed");
  if (deliveryFailed) await releaseEvent(env, claim.key);

  return json({ ok: !deliveryFailed, market: market.key, event_id: payload.eventId, deliveries, request_id: requestId }, deliveryFailed ? 502 : 202, corsHeaders(origin));
}
