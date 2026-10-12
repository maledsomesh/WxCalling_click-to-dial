# Webex Click-to-Call (Customer Assist guest calling)

Website visitors press **Call us** and talk to your Webex Calling **Customer Assist** queue or auto attendant
straight from the browser. They need no account, plug-in or phone number.

This repo contains two parts:

| Part | What it does |
|---|---|
| **Token server** (`server/`) | Holds the Service App credentials. For each call it mints a Webex **guest token** and a **click-to-call (JWE) token** that locks the call to your queue. It has no npm dependencies. |
| **Call widget** (`public/c2c-widget.js` + `.css`) | A drop-in "Call us" button. It loads the Webex Calling SDK, registers the visitor as a guest and places the call, with mute, hold, keypad (DTMF) and hang-up. |

`public/index.html` is a **test page** with a live test console that shows each step of the call.

## Quick start

Requirements: Node.js 20+, a Webex Calling org with **Customer Assist** licenses and click-to-call enabled,
and an authorised Service App. See [docs/SETUP-GUIDE.md](docs/SETUP-GUIDE.md) for the full setup.

```bash
cp .env.example .env      # fill in the Service App token and C2C_DESTINATION
npm run check             # checks .env and each Webex API call
npm start                 # http://localhost:3000
npm test                  # unit + API tests (Webex mocked)
```

Open http://localhost:3000, click **Call us**, then **Start call**, and answer on an agent's Webex App.

> Browsers only allow microphone access on `https://` or `http://localhost`. To test from another device,
> put the server behind HTTPS (for example a reverse proxy, or a tunnel such as ngrok or Cloudflare Tunnel).

## Embed on a website

```html
<link rel="stylesheet" href="https://c2c.example.com/c2c-widget.css">
<script src="https://c2c.example.com/c2c-widget.js" data-api-base="https://c2c.example.com" data-label="Call us" defer></script>
```

Add the website's origin to `ALLOWED_ORIGINS` (for example `https://www.example.com`).

## Documentation

- [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md): architecture, call flow, every component explained, security design.
  Use this to brief the customer's developers.
- [docs/SETUP-GUIDE.md](docs/SETUP-GUIDE.md): step-by-step setup (Control Hub, Service App, configuration, deployment),
  test plan and troubleshooting.

## Repository layout

```
server/
  index.js          entry point: load config, start HTTP server
  function.js       entry point for Google Cloud Run functions (clickToCall)
  config.js         .env loading + validation (fails fast on missing settings)
  app.js            HTTP routes: session API, diagnostics, static files
  webexClient.js    Webex REST calls + Service App token refresh
  rateLimiter.js    per-IP limit on call sessions
public/
  c2c-widget.js     embeddable call widget (Webex Calling SDK)
  c2c-widget.css    widget styles (brand via --c2c-* CSS variables)
  index.html        test page with live test console
scripts/
  check-setup.js    `npm run check`: validates config against the live Webex APIs
test/               node:test suites (no Webex access needed)
Dockerfile          production container (non-root, healthcheck)
```
