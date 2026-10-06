/**
 * Sanitized representative extraction
 * Source: MARKET_LAYER_GADS_GATEWAY/src/{verify-signature,validate-conversion,google-ads-market-config,index}.js
 *
 * Demonstrates HMAC signature verification, conversion schema validation,
 * per-market routing, and the validation-mode upload flow used by the
 * Google Ads gateway service.
 *
 * Production customer IDs, conversion action IDs, and OAuth credentials
 * have been replaced with placeholders.
 *
 * This is NOT the complete production gateway.
 */

const crypto = require("node:crypto");

const MAX_CLOCK_SKEW_SECONDS = 300;

/* =========================================================
 * SIGNATURE VERIFICATION
 * =============================================================== */

function verifySignature({ rawBody, timestamp, signature, secret, now = Math.floor(Date.now() / 1000) }) {
  if (!secret) return { valid: false, error: "SERVER_SECRET_NOT_CONFIGURED" };

  const timestampNumber = Number(timestamp);
  if (!Number.isInteger(timestampNumber)) return { valid: false, error: "INVALID_TIMESTAMP" };
  if (Math.abs(now - timestampNumber) > MAX_CLOCK_SKEW_SECONDS) return { valid: false, error: "EXPIRED_TIMESTAMP" };
  if (!/^sha256=[a-f0-9]{64}$/i.test(signature || "")) return { valid: false, error: "INVALID_SIGNATURE_FORMAT" };

  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const receivedBuffer = Buffer.from(signature.slice(7), "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const valid = crypto.timingSafeEqual(receivedBuffer, expectedBuffer);

  return { valid, error: valid ? null : "SIGNATURE_MISMATCH" };
}

/* =========================================================
 * CONVERSION VALIDATION
 * =============================================================== */

function validateConversion(payload) {
  const errors = [];

  if (!payload || typeof payload !== "object") {
    return { valid: false, errors: ["Body must be a JSON object"] };
  }

  if (!payload.shopId) errors.push("shopId is required");
  if (!payload.marketKey) errors.push("marketKey is required");
  if (!payload.eventId) errors.push("eventId is required");
  if (!payload.orderId) errors.push("orderId is required");
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(payload.conversionDateTime || "")) {
    errors.push("conversionDateTime must use yyyy-mm-dd hh:mm:ss+|-hh:mm");
  }
  if (payload.eventName !== "purchase") errors.push("eventName must be purchase");
  if (!Number.isFinite(payload.value) || payload.value < 0) errors.push("value must be a non-negative number");
  if (!/^[A-Z]{3}$/.test(payload.currency || "")) errors.push("currency must be a three-letter uppercase code");

  const clickIds = ["gclid", "gbraid", "wbraid"].filter((name) => typeof payload[name] === "string" && payload[name].trim());
  if (clickIds.length !== 1) errors.push("Provide exactly one of gclid, gbraid or wbraid");

  return { valid: errors.length === 0, errors };
}

/* =========================================================
 * PER-MARKET ROUTING
 * =============================================================== */

const MARKET_KEYS = ["pl", "de", "en"];

function getGoogleAdsMarketConfig(marketKey, env = process.env) {
  if (!MARKET_KEYS.includes(marketKey)) throw new Error("UNSUPPORTED_MARKET");

  const suffix = marketKey.toUpperCase();
  const customerId = env[`GOOGLE_ADS_CUSTOMER_ID_${suffix}`];
  const conversionActionId = env[`GOOGLE_ADS_CONVERSION_ACTION_ID_${suffix}`];

  if (!customerId || !conversionActionId) throw new Error("MARKET_CONFIG_NOT_FOUND");

  return {
    customerId,
    conversionAction: `customers/${customerId}/conversionActions/${conversionActionId}`,
  };
}

/* =========================================================
 * SERVER (representative)
 * =============================================================== */

const MAX_BODY_SIZE = 64 * 1024;
const mode = process.env.GATEWAY_MODE || "validate";

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readRawBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) { reject(new Error("REQUEST_TOO_LARGE")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

const server = require("node:http").createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/health") {
    return sendJson(response, 200, { status: "ok", service: "gads-gateway", mode });
  }

  if (request.method === "POST" && url.pathname === "/v1/conversions") {
    try {
      const rawBody = await readRawBody(request);

      const authentication = verifySignature({
        rawBody,
        timestamp: request.headers["x-marketlayer-timestamp"],
        signature: request.headers["x-marketlayer-signature"],
        secret: process.env.GATEWAY_SHARED_SECRET,
      });

      if (!authentication.valid) {
        return sendJson(response, 401, { mode, sentToGoogleAds: false, error: authentication.error });
      }

      let payload;
      try { payload = JSON.parse(rawBody || "{}"); }
      catch { return sendJson(response, 400, { mode, sentToGoogleAds: false, valid: false, errors: ["INVALID_JSON"] }); }

      const validation = validateConversion(payload);
      if (!validation.valid) {
        return sendJson(response, 400, { mode, sentToGoogleAds: false, preparedForGoogleAds: false, ...validation });
      }

      const marketConfig = getGoogleAdsMarketConfig(payload.marketKey);

      // In validate mode, the upload is sent to Google Ads API with validateOnly=true.
      // In production mode, this would be a real upload.
      const uploadRequest = {
        conversions: [{
          gclid: payload.gclid,
          conversionAction: marketConfig.conversionAction,
          conversionDateTime: payload.conversionDateTime,
          currencyCode: payload.currency,
          value: payload.value,
          orderId: payload.orderId,
        }],
        validateOnly: true,
      };

      if (mode === "validate") {
        const googleAdsResponse = await uploadGoogleAdsConversions({ customerId: marketConfig.customerId, uploadRequest });
        return sendJson(response, 200, {
          mode,
          sentToGoogleAds: true,
          executedByGoogleAds: false,
          preparedForGoogleAds: true,
          validateOnly: true,
          conversionCount: uploadRequest.conversions.length,
          requestId: googleAdsResponse.requestId,
          googleAdsValidation: googleAdsResponse.result,
          ...validation,
        });
      }

      return sendJson(response, 200, { mode, sentToGoogleAds: false, preparedForGoogleAds: true, validateOnly: uploadRequest.validateOnly, conversionCount: uploadRequest.conversions.length, ...validation });
    } catch (error) {
      return sendJson(response, error.message === "REQUEST_TOO_LARGE" ? 413 : 400, { mode, sentToGoogleAds: false, valid: false, errors: [error.message] });
    }
  }

  sendJson(response, 404, { error: "Not found" });
});

server.listen(process.env.PORT || 8080, "0.0.0.0", () => {
  console.log(`Gateway listening on port ${process.env.PORT || 8080} in ${mode} mode`);
});
