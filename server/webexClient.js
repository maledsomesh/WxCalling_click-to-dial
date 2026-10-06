// Thin client for the three Webex REST calls this solution needs.
// All calls run server-side with the Service App token; none of these
// secrets ever reach the browser.

export class WebexApiError extends Error {
  constructor(message, { status, trackingId, body } = {}) {
    super(message);
    this.name = 'WebexApiError';
    this.status = status;
    this.trackingId = trackingId;
    this.body = body;
  }
}

async function parseResponse(res, what) {
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const detail = body.message || body.errors?.[0]?.description || body.raw || res.statusText;
    throw new WebexApiError(`${what} failed (${res.status}): ${detail}`, {
      status: res.status,
      trackingId: res.headers.get('trackingid') || undefined,
      body,
    });
  }
  return body;
}

// Supplies a valid Service App access token. Uses the refresh-token grant when
// client credentials are configured, otherwise the static token from .env.
export class ServiceAppTokenProvider {
  constructor(webexConfig, { fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.cfg = webexConfig;
    this.fetch = fetchImpl;
    this.now = now;
    this.refreshToken = webexConfig.refreshToken;
    this.accessToken = null;
    this.expiresAt = 0;
    this.inflight = null;
  }

  get canRefresh() {
    return Boolean(this.cfg.clientId && this.cfg.clientSecret && this.refreshToken);
  }

  async getToken() {
    if (!this.canRefresh) return this.cfg.accessToken;
    // Refresh 5 minutes before expiry; share one refresh between concurrent callers.
    if (this.accessToken && this.now() < this.expiresAt - 5 * 60 * 1000) return this.accessToken;
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async refresh() {
    const res = await this.fetch(`${this.cfg.apiBase}/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: this.refreshToken,
      }),
    });
    const body = await parseResponse(res, 'Service App token refresh');
    this.accessToken = body.access_token;
    this.expiresAt = this.now() + (body.expires_in ?? 3600) * 1000;
    if (body.refresh_token) this.refreshToken = body.refresh_token;
    return this.accessToken;
  }
}

export class WebexClient {
  constructor(webexConfig, tokenProvider, { fetchImpl = fetch } = {}) {
    this.apiBase = webexConfig.apiBase;
    this.tokens = tokenProvider;
    this.fetch = fetchImpl;
  }

  async post(path, payload, what) {
    const token = await this.tokens.getToken();
    const res = await this.fetch(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return parseResponse(res, what);
  }

  // Step 1: a short-lived guest identity the browser SDK authenticates with.
  async createGuestToken({ subject, displayName }) {
    const body = await this.post('/guests/token', { subject, displayName }, 'Guest token');
    if (!body.accessToken) throw new WebexApiError('Guest token response had no accessToken', { body });
    return { accessToken: body.accessToken, expiresIn: body.expiresIn };
  }

  // Step 2: an encrypted (JWE) click-to-call token that pins the destination.
  async createCallToken({ calledNumber, guestName }) {
    const body = await this.post('/telephony/click2call/callToken', { calledNumber, guestName }, 'Click-to-call token');
    if (!body.callToken) throw new WebexApiError('Click-to-call token response had no callToken', { body });
    return body.callToken;
  }
}
