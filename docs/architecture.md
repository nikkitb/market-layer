# Architecture

## Component Boundaries

### Browser Adapter

The browser adapter is a Shoper Storefront module. It subscribes to the official Shoper `storefront.events.analytics` event bus, normalizes events to canonical names, resolves the market from hostname and language, and dispatches to browser-side destinations.

Responsibilities:
- Event subscription and capture
- Normalization (Shoper event name → canonical event → destination payloads)
- Market resolution (`resolveRouting()`)
- Consent state management (Shoper Customer Privacy API → Google Consent Mode)
- Event identity generation (`createEventId()`)
- Browser delivery (GA4, Google Ads, Meta Pixel)
- Server envelope preparation and dispatch
- Tag discovery reporting

### Cloudflare Worker

The Worker is the server-side gateway. It accepts `POST /v1/events`, validates the origin and envelope, resolves the market, claims the event in D1, and forwards to GA4 Measurement Protocol and Meta Conversions API.

Responsibilities:
- Origin CORS validation
- Envelope schema validation
- Market resolution (must match request origin)
- D1 event deduplication
- Server-side consent enforcement
- GA4 Measurement Protocol delivery
- Meta CAPI delivery with PII hashing
- Config and discovery persistence

### Config / D1

Config is persisted in Cloudflare D1 (`tracking_config` table). A singleton row stores the full JSON config. Meta access tokens are encrypted with AES-256-GCM before persistence and decrypted on read.

Responsibilities:
- Config normalization and validation
- Secret encryption/decryption
- D1 read/write
- Tag discovery persistence

### Client Panel

A merchant-facing UI served from the Worker. Authenticated via `CONFIG_ADMIN_TOKEN`. Allows editing markets, destinations, and server toggles. Domain status and tag discovery are displayed.

Responsibilities:
- Owner authentication
- Config editing UI
- Domain status display
- Connection badge display
- Meta secret management

### Live Signal Inspector

A debug overlay installed in the storefront theme. Reads adapter state via `inspect()` and renders routing, consent, delivery status, and session journey.

Responsibilities:
- State polling and rendering
- Session journey storage and compaction
- Desktop/mobile responsive views

### Google Ads Gateway

A separate Node.js service (Cloud Run) for validated Google Ads conversion uploads. Authenticated via HMAC-SHA256. Currently operates in `validateOnly` mode.

Responsibilities:
- HMAC signature verification
- Purchase validation (exactly-one click-ID)
- Per-market routing to Google Ads customer/conversion-action IDs
- OAuth token exchange
- `uploadClickConversions` API call

## Event Flow

```mermaid
flowchart TD
    A[Shoper Event Bus] --> B[record()]
    B --> C[normalize()]
    C --> D[resolveRouting()]
    D --> E{matched?}
    E -->|no| F[skip]
    E -->|yes| G{consent?}
    G -->|denied| H[blocked]
    G -->|granted| I[dispatch]
    I --> J[sendGa4]
    I --> K[sendGoogleAds]
    I --> L[sendMetaPixel]
    I --> M[sendServer]
    M --> N[Worker /v1/events]
    N --> O[D1 claim]
    O --> P{duplicate?}
    P -->|yes| Q[202 duplicate]
    P -->|no| R[sendGa4 MP]
    P -->|no| S[sendMeta CAPI]
    R --> T{success?}
    S --> T
    T -->|no| U[release claim]
    T -->|yes| V[202 ok]
```

## Browser/Server Split

Browser delivery is immediate and consent-gated. Server delivery is optional per market and destination. The adapter builds a server envelope containing:

- `eventId` (shared with browser Meta)
- `market` (hostname, language, pathname)
- `consent` (analytics, marketing, ad_user_data, ad_personalization, plus Shoper and Google Consent Mode mappings)
- `ga4` (optional)
- `meta` (optional, with `user_data` for enhanced matching)
- `pageUrl`
- `fbp` / `fbc` (Meta cookies)

The Worker validates this envelope and forwards only the destinations that are enabled and consented.

## Configuration Flow

1. Merchant opens Client Panel (`/app/`)
2. Panel loads config via `GET /v1/config` (redacted)
3. Merchant edits market settings and clicks Save
4. Panel sends `PUT /v1/config` with Bearer token
5. Worker normalizes, validates, encrypts secrets, and writes to D1
6. Adapter fetches `GET /v1/config` on boot with `cache: "no-store"`
7. Adapter overrides local defaults with saved config

## Validation Boundaries

- **Browser:** adapter validates routing and consent before each delivery; does not send if routing is ambiguous or consent is denied
- **Worker:** validates origin, payload size (64 KB), envelope schema, market match, and D1 dedup
- **Google Ads Gateway:** validates HMAC timestamp (±300s), signature format, and conversion schema (exactly-one click-ID)
