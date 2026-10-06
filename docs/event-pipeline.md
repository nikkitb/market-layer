# Event Pipeline

This document traces one representative ecommerce event — a purchase — through the actual Market Layer implementation.

## 1. Storefront Signal

Shoper emits `analytics.purchased` on the storefront event bus. The payload contains order details, basket summary, and customer data.

```json
{
  "orderId": "DEMO-ORDER-1001",
  "basket": {
    "sumToPay": {
      "grossValue": 249.90,
      "currency": "PLN"
    },
    "productsSum": {
      "grossValue": 249.90
    }
  },
  "items": [
    {
      "id": "SKU-001",
      "name": "Sample Product",
      "producer": {
        "name": "Sample Brand"
      },
      "category": {
        "name": "Electronics"
      },
      "price": {
        "grossValue": 249.90
      },
    "quantity": 1
    }
  ],
  "customer": {
    "email": "customer@example.com",
    "firstName": "Jan",
    "lastName": "Kowalski"
  }
}
```

## 2. Capture

`record("analytics.purchased", "event-bus", payload)` is called. The adapter stores a lightweight entry in `state.events` (source, receivedAt, sanitized payload summary) and dispatches a `crossborder:signal` custom event.

## 3. Normalization

`normalize()` maps the event:

- `shoperEvent` → `"analytics.purchased"`
- `canonicalEvent` → `"order.purchased"`
- `eventId` → UUID v4
- `market` → current hostname + language
- `ga4.params` → `{ event: "purchase", params: { transaction_id, currency, value, items } }`
- `googleAds.params` → same params as GA4
- `meta` → `{ event_name: "Purchase", event_id, custom_data: { currency, value, content_type, content_ids, contents, num_items } }`

Private customer data (email, phone, name, address) is extracted via `extractPrivateUserData()` and stored in a `WeakMap` keyed by the normalized event. It is never placed in adapter state, diagnostics, or the `inspect()` result. It is attached to the server envelope only for Meta CAPI, where it is hashed server-side.

## 4. Market Resolution

`resolveRouting()` compares `window.location.hostname` and `document.documentElement.lang` against the `MARKETS` configuration (fetched from `/v1/config`). A match requires both hostname and language to align with exactly one market.

Example match:
```json
{
  "status": "matched",
  "marketKey": "pl",
  "measurementId": "G-XXXXXXXXXX",
  "evidence": {
    "hostname": "shop.example.com",
    "language": "pl"
  }
}
```

Unmatched or ambiguous markets result in `status: "unmatched"` or `"ambiguous"` and delivery is skipped.

## 5. Consent

`updateConsentState()` reads Shoper's `customerPrivacyApi.getGrantedNames()`. Independent consent flags are set:

- `analytics` → `analyticsConsent` granted
- `marketing` → `marketingConsent` granted

Google Consent Mode is synchronized:
```json
{
  "analytics_storage": "granted",
  "ad_storage": "granted",
  "ad_user_data": "granted",
  "ad_personalization": "granted"
}
```

If consent is granted after the initial page view, `replayInitialPageView()` creates a copy of the initial page view with a new `eventId` and re-dispatches it through the consent-aware pipeline.

## 6. Event Identity

`createEventId()`:
```js
const createEventId = () => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
};
```

The same `eventId` is attached to the Meta browser event (`meta.event_id`) and the server envelope (`eventId`), enabling browser/server deduplication on Meta's side.

## 7. Destination Representation

### GA4 Browser

```json
{
  "event": "purchase",
  "params": {
    "transaction_id": "DEMO-ORDER-1001",
    "currency": "PLN",
    "value": 249.90,
    "items": [
      {
        "item_id": "SKU-001",
        "item_name": "Sample Product",
        "item_brand": "Sample Brand",
        "item_category": "Electronics",
        "price": 249.90,
        "quantity": 1
      }
    ]
  },
  "send_to": "G-XXXXXXXXXX"
}
```

### Google Ads Browser

```json
{
  "event": "conversion",
  "send_to": "AW-XXXXXXXXXX/LABEL",
  "value": 249.90,
  "currency": "PLN",
  "transaction_id": "DEMO-ORDER-1001"
}
```

### Meta Pixel Browser

```json
{
  "event": "track",
  "eventName": "Purchase",
  "params": {
    "currency": "PLN",
    "value": 249.90,
    "content_type": "product",
    "content_ids": ["SKU-001"],
    "contents": [
      {
        "id": "SKU-001",
        "quantity": 1,
        "item_price": 249.90
      }
    ],
    "num_items": 1
  },
  "options": {
    "eventID": "UUID"
  }
}
```

## 8. Browser/Server Delivery

`sendServer()` builds the server envelope only if `transport.serverGa4` or `transport.serverMeta` is enabled:

```json
{
  "eventId": "UUID",
  "market": {
    "hostname": "shop.example.com",
    "language": "pl",
    "pathname": "/order/confirm"
  },
  "consent": {
    "analytics_storage": "granted",
    "ad_storage": "granted",
    "ad_user_data": "granted",
    "ad_personalization": "granted",
    "shoper": { "analyticsConsent": true, "marketingConsent": true },
    "googleConsentMode": { "analytics_storage": "granted", "ad_storage": "granted" }
  },
  "ga4": { "event": "purchase", "params": { ... } },
  "meta": {
    "event_name": "Purchase",
    "event_id": "UUID",
    "custom_data": { ... },
    "user_data": {
      "em": ["HASHED_EMAIL"],
      "ph": ["HASHED_PHONE"],
      "fn": ["HASHED_FIRST_NAME"]
    }
  },
  "pageUrl": "https://shop.example.com/order/confirm",
  "fbp": "FB_FULL_PLACEMENT_ID",
  "fbc": "FB_CLICK_ID"
}
```

## 9. Deduplication

### Browser

GA4 browser delivery uses an in-memory `sentPurchases` Set. Before sending a `purchase` event, the adapter checks whether the `transaction_id` is already present. If so, the event is skipped.

### Server

D1 `event_claims` table:
```sql
INSERT OR IGNORE INTO event_claims (event_key, created_at) VALUES (?, ?)
```

`event_key` = `${marketKey}:${eventId}`. If the insert returns `changes === 0`, the event is a duplicate and the Worker returns HTTP 202 immediately. If delivery fails (HTTP 502), the claim is deleted so the event can be retried.

## 10. Validation

The adapter does not expose raw customer data in `state` or `inspect()`. Private fields are extracted into a `WeakMap` and only sent to the Worker, where `buildMetaUserData()` hashes them with SHA-256 before forwarding to Meta CAPI.

The Worker enforces:
- Origin must match a configured market hostname
- Payload size ≤ 64 KB
- Envelope must contain valid `market`, `consent`, `eventId`, and at least one destination payload
- Market must match the request origin
- Event must not already be claimed in D1
