# How the Click-to-Call solution works

This document explains the build so a development team can understand it, run it, and rebuild it on its own
stack. For setup steps see [SETUP-GUIDE.md](SETUP-GUIDE.md).

## 1. What problem it solves

A visitor on the customer's website presses **Call us**. Their browser becomes a softphone and the call lands
in a **Webex Calling Customer Assist** call queue (or auto attendant). Agents answer in the Webex App as they
would any queue call.

- The visitor needs no Webex account, app, plug-in or phone. The call is WebRTC audio from the browser.
- No PSTN number or minutes are used. The call stays inside Webex Calling.
- The feature is Cisco's **guest click-to-call**. It requires a **Customer Assist** license in the org.

## 2. Three building blocks

| # | Block | Owner | Where it lives |
|---|---|---|---|
| 1 | **Control Hub configuration**: click-to-call enabled, destination queue / auto attendant, Service App authorised | Webex admin | Control Hub |
| 2 | **Token server**: holds the Service App credentials and mints per-call tokens | Customer's backend team | `server/` (any HTTPS host) |
| 3 | **Call widget**: the "Call us" button, using the Webex Calling **Web SDK** | Customer's web team | `public/c2c-widget.js` embedded on the website |

The Cisco documents map onto these blocks:

- The help article ("Enable customers to reach your organization using browser-based click-to-call") covers block 1.
- The **Beta Click-to-call API** (`POST /v1/telephony/click2call/callToken`) is used by block 2.
- The **Web Calling SDK click-to-call guide** and the WebexSamples demo cover block 3.

They are three parts of one solution, not alternatives.

## 3. Architecture

```
 Visitor's browser                Token server (this repo)              Webex cloud
 ─────────────────                ────────────────────────              ───────────
 website + c2c-widget.js
   "Call us" ── (1) POST ───────► /api/c2c/session
                                    • origin check, rate limit
                                    • Service App secret lives here ── (2) ──► /v1/access_token (refresh)
                                                                              /v1/guests/token
   ◄──────────── guestToken + JWE ◄──────────────────────────────────────── /v1/telephony/click2call/callToken

 Webex Calling SDK
   init → register → makeCall → dial ── (3) WebRTC signalling + SRTP media ──► Webex Calling (guest line)
                                                                              → Customer Assist queue / AA
                                                                              → agent's Webex App rings
```

## 4. Call flow, step by step

```
Visitor            Widget (browser)             Token server                  Webex
   │ click Call us     │                              │                           │
   │──────────────────►│ 1. load SDK (pinned ver.)    │                           │
   │                   │ 2. ask for microphone        │                           │
   │ allow mic ───────►│                              │                           │
   │                   │ 3. POST /api/c2c/session ───►│ origin ok? rate limit ok? │
   │                   │                              │── POST /guests/token ────►│ guest identity
   │                   │                              │── POST /click2call/       │
   │                   │                              │      callToken ──────────►│ JWE (destination
   │                   │◄──── guestToken + JWE ───────│                           │  sealed inside)
   │                   │ 4. Calling.init(guest token, │                           │
   │                   │    indicator 'guestcalling', │                           │
   │                   │    jwe) → register line ─────┼──────────────────────────►│ guest device registered
   │                   │ 5. line.makeCall(); dial(mic)┼──────────────────────────►│ → queue → agent rings
   │                   │◄── progress / connect / remote_media ────────────────────│
   │ talks to agent    │ mute · hold · DTMF · end     │                           │
   │                   │ 6. deregister, stop mic      │                           │
```

1. **Load the SDK.** The widget loads `https://unpkg.com/webex@<version>/umd/calling.min.js`. The version is
   pinned by the server (`WEBEX_SDK_VERSION`, tested with **3.12.0**). This exposes the global `Calling`.
2. **Microphone first.** `Calling.createMicrophoneStream({audio:true})` prompts the visitor. If they decline,
   the widget stops before any Webex tokens are created.
3. **Get a session.** The widget calls `POST /api/c2c/session` with an optional visitor name. The server
   makes two Webex API calls in parallel using the **Service App** token:
   - `POST /v1/guests/token` `{subject, displayName}` returns `accessToken`, a short-lived **guest identity**.
     The subject is a fresh UUID for every call, so concurrent visitors never share a guest identity.
   - `POST /v1/telephony/click2call/callToken` `{calledNumber, guestName}` returns `callToken`, an encrypted
     **JWE** that contains the destination. `calledNumber` always comes from server configuration
     (`C2C_DESTINATION`), so a visitor cannot redirect the call anywhere else.
4. **Register as a guest.** The widget calls `Calling.init({ webexConfig, callingConfig })`:
   - `webexConfig.credentials.access_token` is the guest token.
   - `callingConfig.callingClientConfig.serviceData` is `{ indicator: 'guestcalling', domain: '', guestName }`.
   - `callingConfig.callingClientConfig.jwe` is the JWE call token.
   - `discovery: { region, country }` is an optional media-region hint.

   On `ready` it calls `calling.register()`, takes the first line from `callingClient.getLines()` and calls
   `line.register()`. It waits up to 30 s for the line's `registered` event.
5. **Call.** `line.makeCall()` is called **with no destination**. In guest mode the SDK takes the
   destination from the JWE. Then `call.dial(micStream)`. Call events drive the UI:

   | Event | What the widget does |
   |---|---|
   | `progress` | Shows "Ringing" |
   | `connect` / `established` | Shows "Connected" and starts the timer |
   | `remote_media` | Plays the agent's audio |
   | `disconnect` | Ends the call |
   | `call_error` | Shows a friendly error |

   In-call controls: `call.mute(mic)`, `call.doHoldResume()`, `call.sendDigit(d)` for auto attendant menus,
   and `call.end()`.
6. **Clean up.** The widget stops the microphone and deregisters the line and device. The tokens are thrown
   away, and the next call gets new ones.

## 5. Component walkthrough

### Token server (`server/`)

| File | Responsibility |
|---|---|
| `config.js` | Reads `.env` / environment, validates it, and refuses to start if something is missing. |
| `webexClient.js` | `ServiceAppTokenProvider`: returns the Service App access token. It runs in one of two modes: a **static** token (quick PoC) or **refresh** mode, which uses client id + secret + refresh token, renews automatically 5 min before expiry and shares one refresh across concurrent requests. `WebexClient`: the two Webex calls above. On errors it keeps the Webex `trackingid` for Cisco TAC. |
| `rateLimiter.js` | Limits sessions per client IP (default 5 per 10 min). This stops bots from flooding the queue or burning guest tokens. |
| `app.js` | Routes (table below), security checks, error handling and static hosting of the widget and test page. |
| `index.js` | Wires everything together and starts the HTTP server (local, Docker, Cloud Run service). |
| `function.js` | Same wiring, exported as the `clickToCall` handler for Google Cloud Run functions. |
| `scripts/check-setup.js` | `npm run check`: runs every Webex call with the real credentials, says which setup step is missing, and gives a hint for each failure. |

Routes:

| Method + path | Purpose |
|---|---|
| `GET /api/config` | Public: SDK version, whether a visitor name is accepted. |
| `POST /api/c2c/session` | Creates the call session (guest token + JWE). Only allowed from the same origin or `ALLOWED_ORIGINS`. Rate limited. Responses are `no-store`. |
| `GET /api/diagnostics` | Same checks as `npm run check`, over HTTP. Needs the `X-Diagnostics-Key` header and is disabled unless `DIAGNOSTICS_KEY` is set. Never returns token values. |
| `GET /healthz` | Liveness probe for load balancers and containers. |
| `GET /*` | Serves `public/` (widget + test page). |

The server deliberately uses **no framework and no npm dependencies**, so it is easy to read and to port. The
whole Webex integration is about 100 lines in `webexClient.js` plus the session handler in `app.js`. A team on
another stack (.NET, Java, Python, Azure Functions, AWS Lambda) only has to reimplement:

1. Obtain and refresh the Service App token.
2. `POST /v1/guests/token`.
3. `POST /v1/telephony/click2call/callToken` with a **server-side** destination.
4. Return `{ guestToken, callToken, guestName }` to the browser, behind an origin check and rate limit.

### Call widget (`public/c2c-widget.js`)

This is plain JavaScript with no build step. It adds a floating button and a panel and runs the flow in
section 4. It is driven by a simple state machine:

`idle → sdk → mic → session → registering → dialing → ringing → connected → ended | error`

The host website can listen to `webex-c2c:state` and `webex-c2c:log` events on `window`, for example for
analytics. The test page uses them for its live console. Branding is done with CSS variables (`--c2c-accent`,
…) in `c2c-widget.css`. Light and dark mode are built in.

## 6. Security design

| Risk | How it is handled |
|---|---|
| Service App token leaks (it can create guests and call tokens for the org) | It stays on the server and is never sent to the browser. The Cisco demo puts it in browser JavaScript; **do not do that in production**. |
| Visitor redirects the call (toll fraud, internal numbers) | The destination is set only on the server (`C2C_DESTINATION`) and sealed inside the JWE. The browser calls `makeCall()` with no number, and any destination in the request body is ignored. |
| Other websites or bots use your token endpoint | Origin allow-list (`ALLOWED_ORIGINS`, same-origin by default) and a per-IP rate limit. For public production, also put the endpoint behind a WAF / bot protection or a CAPTCHA. |
| Visitor-supplied name shown to agents | Sanitised to letters, digits and basic punctuation, max 40 characters. It can be disabled with `C2C_ALLOW_GUEST_NAME=false`. |
| Error details leak internals | The browser gets a generic message. Server logs keep the Webex error and `trackingId`. |
| Supply chain (SDK from a CDN) | The SDK version is pinned. For production you can self-host `calling.min.js` and change the URL in `loadSdk()`, or add Subresource Integrity. |

## 7. Production considerations

- **HTTPS is mandatory.** Browsers block microphone access on plain HTTP, except on `localhost`.
- **Service App token lifetime.** Use refresh mode (`WEBEX_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN`) so tokens renew
  without manual work. The refresh token itself also expires eventually. Calendar a reminder, or re-authorise
  the Service App before then. Keep the secrets in a secret manager (Key Vault, AWS Secrets Manager, Vault).
- **Several instances.** The rate limiter is in memory, per instance. Behind a load balancer, set
  `TRUST_PROXY` to the number of proxies (1 on Cloud Run) and use the gateway's or WAF's rate limiting (e.g. Cloud Armor), or a shared store.
- **Business hours.** Handle closed hours in the Customer Assist queue / auto attendant schedule. You can also
  hide the button on the website outside hours.
- **Browser support.** Use current Chrome, Edge, Firefox or Safari (WebRTC). Corporate networks must allow
  Webex media. Cisco publishes the Webex network requirements (ports and IP ranges).
- **Monitoring.** `/healthz` for liveness, `npm run check` or `/api/diagnostics` for end-to-end Webex checks,
  and JSON logs with `sessionId` and Webex `trackingId`.
