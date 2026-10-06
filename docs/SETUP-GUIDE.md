# Setup, test and deployment guide

Follow these steps in order. Each phase ends with a check, so a failure is caught in the phase that caused it.
For background see [HOW-IT-WORKS.md](HOW-IT-WORKS.md).

> **Verify in Cisco's docs.** Control Hub menu names and API scope names change over time. Where this guide
> says *verify*, confirm against the current Cisco pages:
> - [Enable customers to reach your organization using browser-based click-to-call](https://help.webex.com/en-us/article/ndzk21eb/Enable-customers-to-reach-your-organization-using-browser-based-click-to-call)
> - [Beta Click-to-call API reference](https://developer.webex.com/calling/docs/api/v1/beta-click-to-call)
> - [Web Calling SDK: Click to Call](https://developer.webex.com/calling/docs/sdks/web-calling-sdk-click-to-call)

## Who does what

| Phase | Role | Time |
|---|---|---|
| 1. Licensing and Control Hub | Webex full administrator | about half a day |
| 2. Service App | Developer + Webex full administrator | about 1 hour |
| 3. Configure and run the token server | Developer | about 1 hour |
| 4. Test calls | Developer + a test agent | about 1 hour |
| 5. Deploy and embed on the website | DevOps + web team | 1–3 days |

## Phase 1: Licensing and Control Hub (Webex admin)

1. **Licenses.** The org needs **Webex Calling Customer Assist** licenses. Click-to-call is only available to
   Customer Assist orgs. Each agent needs a Webex Calling Professional license plus Customer Assist.
2. **Destination.** Create, or pick, a **Customer Assist call queue**, or an **auto attendant** if callers
   should hear a menu first. Note its phone number or extension: this is `C2C_DESTINATION`. Add at least one
   test agent and make sure the agent can receive calls in the Webex App.
3. **Enable click-to-call.** In Control Hub, enable click-to-call for the organization and allow the
   destination queue / auto attendant. Set the privacy options the article describes. *Verify the exact menu
   path in the help article.*
4. **Beta access, if still required.** When the feature launched, the click-to-call API was a beta that
   needed registration on the Webex Developer Portal. If the API page still says *Beta*, register the org
   there first.

**Check:** the test agent can receive a normal internal call to the queue number.

## Phase 2: Service App (developer + admin)

A Service App is a machine identity that belongs to the org, not to a person. The token server acts as
this Service App.

1. A developer signs in to [developer.webex.com](https://developer.webex.com), goes to **My Webex Apps**,
   chooses **Create a New App**, then **Service App**.
2. Select these scopes:
   - `guest-issuer:write` and `guest-issuer:read`: create guest identities.
   - `spark:webrtc_calling`: WebRTC calling.
   - The **click-to-call scope** listed on the Beta Click-to-call API page (needed for `callToken`).
     *Verify the exact scope name on that page.*
3. Save the app and note its **Client ID** and **Client Secret**. The secret is shown once.
4. A **full administrator** of the customer org opens **Control Hub**, goes to **Apps**, then **Service Apps**,
   finds the app and **authorises** it.
5. Back in the Developer Portal, on the Service App page, select the authorised org and **generate tokens**.
   You get an **access token** and a **refresh token**.

**Check:** the Service App shows as *Authorised* in Control Hub.

## Phase 3: Configure and run the token server (developer)

Requirements: Node.js 20 or newer. No `npm install` is needed because the server has no dependencies.

```bash
git clone <this repo> && cd WxCalling_click-to-dial
cp .env.example .env
```

Edit `.env`:

| Variable | Value |
|---|---|
| `WEBEX_SERVICE_APP_ACCESS_TOKEN` | Access token from Phase 2. Fine for a PoC; it expires. |
| `WEBEX_CLIENT_ID`, `WEBEX_CLIENT_SECRET`, `WEBEX_REFRESH_TOKEN` | **Recommended.** The server then renews the access token itself. These take precedence over the static token. |
| `C2C_DESTINATION` | Queue / auto attendant number from Phase 1. |
| `C2C_GUEST_NAME` | Name agents see, for example `Website Caller`. If the visitor types a name it is appended: `Website Caller - Jane`. |
| `C2C_ALLOW_GUEST_NAME` | `false` to hide the name field. |
| `WEBEX_SDK_VERSION` | Pinned SDK version (default `3.12.0`). Upgrade deliberately and retest. |
| `WEBEX_REGION`, `WEBEX_COUNTRY` | Optional media-region hint (Cisco's sample uses `US-EAST` / `US`). Leave blank to let the SDK discover it. |
| `ALLOWED_ORIGINS` | Website origins allowed to start calls, comma-separated, e.g. `https://www.customer.com`. Leave blank for the bundled test page. |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_SECONDS` | Calls per IP per window (default 5 per 600 s). |
| `TRUST_PROXY` | Number of proxies in front of the server, so the real client IP is used for rate limiting: `true`/`1` on Cloud Run or behind one reverse proxy, `2` for Cloud Run behind an external load balancer. |
| `DIAGNOSTICS_KEY` | Long random string to enable `GET /api/diagnostics`. Blank disables it. |

Validate against the live Webex APIs:

```bash
npm run check
```

Expected output:

```
✓ .env configuration is complete
✓ Service App access token  [refresh-token (auto renew)]
✓ Guest token  (POST /v1/guests/token)  [expiresIn=...s]
✓ Call token   (POST /v1/telephony/click2call/callToken)  [destination=+1...]
All checks passed
```

Each failed step prints a hint. See also [Troubleshooting](#troubleshooting).

Start the server:

```bash
npm start      # http://localhost:3000
npm test       # optional: automated tests, no Webex access needed
```

## Phase 4: Test calls

Open **http://localhost:3000** in Chrome, Edge, Firefox or Safari. It must be `localhost` or HTTPS, or the
microphone is blocked. Sign the test agent in to the Webex App and make them available in the queue.

| # | Test | Expected result |
|---|---|---|
| 1 | Click **Call us**, enter a name, then **Start call** and allow the mic | The console shows: SDK loaded, mic granted, session created, line registered, Dialing, Ringing |
| 2 | Agent answers | Widget shows **Connected** and the timer runs. Two-way audio works. The agent sees the guest name. |
| 3 | **Mute** / **Unmute** | Agent stops / resumes hearing the caller |
| 4 | **Hold** / **Resume** | Agent hears hold, then the call resumes |
| 5 | Destination is an auto attendant: **Keypad** then a digit | The menu option is selected (DTMF) |
| 6 | Caller presses **End call** | Call ends on both sides. Console shows "Guest device deregistered". |
| 7 | Agent hangs up first | Widget shows **Call ended** |
| 8 | Visitor **blocks** the microphone | Friendly message. No session is created (no "Session ... created" line). |
| 9 | Start more calls than `RATE_LIMIT_MAX` in the window | "Too many call attempts" message |
| 10 | No agent available / outside hours | Queue overflow or closed-hours treatment plays, as configured in Control Hub |
| 11 | Mobile browser (Android Chrome, iOS Safari) over HTTPS | Same as tests 1–7 |

To test from a phone or another PC you need HTTPS. Either deploy (Phase 5) or use a tunnel, for example
`ngrok http 3000`, and open the `https://` URL it gives you.

## Phase 5: Deploy and embed on the website

### Deploy the token server

The server is one stateless Node process. Options:

```bash
docker build -t webex-c2c .
docker run -p 3000:3000 --env-file .env webex-c2c
```

It runs unchanged on Azure App Service, AWS App Runner / ECS, Google Cloud Run, Kubernetes or a VM behind a
reverse proxy. Requirements:

- **HTTPS** in front, terminated at a load balancer or reverse proxy. Set `TRUST_PROXY` to the number of proxies.
- **Secrets** (client secret, refresh token) come from the platform's secret store as environment variables.
  Never commit `.env`.
- **Outbound access** to `https://webexapis.com`.
- **Health probe:** `GET /healthz`.
- **Several instances:** the built-in rate limit is per instance. Add rate limiting and bot protection at
  the gateway / WAF.

### Google Cloud Run

Two options. Both give you HTTPS automatically and need no code changes.

**Cloud Run service (recommended)**, built from the included `Dockerfile`:

```bash
gcloud secrets create webex-c2c-client-secret --data-file=-   # paste secret, then Ctrl-D
gcloud secrets create webex-c2c-refresh-token --data-file=-
gcloud run deploy webex-c2c --source . --region europe-west1 --allow-unauthenticated \
  --min-instances 1 \
  --set-env-vars WEBEX_CLIENT_ID=...,C2C_DESTINATION=...,TRUST_PROXY=1,ALLOWED_ORIGINS=https://www.customer.com \
  --set-secrets WEBEX_CLIENT_SECRET=webex-c2c-client-secret:latest,WEBEX_REFRESH_TOKEN=webex-c2c-refresh-token:latest
```

**Cloud Run functions**: the entry point is `clickToCall` in `server/function.js` (`main` in `package.json`).

```bash
gcloud functions deploy webex-c2c --gen2 --runtime nodejs22 --region europe-west1 \
  --source . --entry-point clickToCall --trigger-http --allow-unauthenticated \
  --min-instances 1 \
  --set-env-vars ... --set-secrets ...      # same values as above
```

Points that matter on Cloud Run:

| Topic | What to do |
|---|---|
| `--allow-unauthenticated` | Required: website visitors call the endpoint anonymously. Protection comes from `ALLOWED_ORIGINS` and the rate limit, not from IAM. |
| `TRUST_PROXY` | **Must** be `1` (or `2` behind an external load balancer). Otherwise every visitor appears to come from Google's front-end IP and shares one rate-limit bucket, so the whole site gets 5 calls per 10 minutes. After deploying, place a call and check the `ip` in the `session created` log line is your public IP. |
| Rate limiting | The built-in limiter is per instance, and instances come and go, so treat it as a safety net. For real protection put an external Application Load Balancer with **Cloud Armor** rate limiting / bot management in front (then `TRUST_PROXY=2`). |
| Cold starts | Scale-to-zero adds a few seconds to the first call. `--min-instances 1` keeps one instance warm (small monthly cost). |
| Secrets | Use Secret Manager (`--set-secrets`), never a `.env` file in the source upload. The included `.gcloudignore` keeps `.env` out of the upload. |
| Egress | Needs outbound HTTPS to `webexapis.com`. The default works; if you route all egress through a VPC, make sure Cloud NAT is set up. |
| Custom domain | Map e.g. `c2c.customer.com` to the service and use it as `data-api-base`. |

If the customer prefers their own backend stack, they only need to port the session endpoint. See
*Component walkthrough* in [HOW-IT-WORKS.md](HOW-IT-WORKS.md).

### Embed the widget

Add the website's origin to `ALLOWED_ORIGINS`, then add these lines to the website pages:

```html
<link rel="stylesheet" href="https://c2c.customer.com/c2c-widget.css">
<script src="https://c2c.customer.com/c2c-widget.js"
        data-api-base="https://c2c.customer.com"
        data-label="Call us" defer></script>
```

- **Branding:** override the CSS variables, for example
  `.c2c-root { --c2c-accent: #003a70; --c2c-accent-text: #fff; }`.
- **Your own button:** set `data-auto-mount="false"` and call
  `window.WebexClickToCall.mount({ apiBase: 'https://c2c.customer.com', label: 'Talk to us' })`.
- **Analytics:** listen for `window.addEventListener('webex-c2c:state', e => ...)`.
- **Content Security Policy:** if the site uses CSP, allow `script-src https://unpkg.com` (or self-host the
  SDK), `connect-src` to the token server and Webex domains, and `media-src blob:`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `npm run check`: Service App token **401** | Token expired or wrong | Regenerate in the Developer Portal, or use refresh mode |
| Guest token **403** | Missing `guest-issuer` scopes, or the Service App is not authorised | Add the scopes, then have the admin re-authorise in Control Hub |
| Call token **403/400** | Click-to-call not enabled, no Customer Assist license, the destination is not a click-to-call-enabled queue / auto attendant, missing click-to-call scope, or beta not registered | Recheck Phase 1 and Phase 2 |
| Network error in `npm run check` | Server cannot reach `webexapis.com` | Open egress / proxy |
| Widget: "Could not reach the click-to-call server" | Wrong `data-api-base`, or the server is down | Check the URL and `/healthz` |
| Browser console: 403 "Origin not allowed" | Website origin not in `ALLOWED_ORIGINS` | Add the exact origin (scheme + host + port) |
| "Microphone access was blocked" | Visitor denied it, or the page is not HTTPS | Use HTTPS. Have the visitor allow the mic in site settings. |
| Stuck on "Connecting…", then "Registration timed out" | Webex media/signalling blocked by a firewall, or wrong region hint | Try another network. Clear `WEBEX_REGION`. Check Webex network requirements. |
| Connected but no audio | Firewall blocks UDP media, or the browser output device | Test on another network or device. Check the audio output. |
| Agent never rings | No available agent, queue routing or closed hours | Check the queue in Control Hub |

When opening a Cisco TAC case, include the **trackingId** from the server log (`npm start` output) or from
`npm run check`.
