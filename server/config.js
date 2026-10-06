// Loads configuration from environment variables (and an optional .env file)
// and validates it once at startup, so misconfiguration fails fast.
import { existsSync, readFileSync } from 'node:fs';

export function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    // Real environment variables win over .env (12-factor style).
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const bool = (v, dflt) => (v === undefined || v === '' ? dflt : /^(1|true|yes)$/i.test(v));
const int = (v, dflt) => (v === undefined || v === '' ? dflt : Number.parseInt(v, 10));
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export function buildConfig(env = process.env) {
  const config = {
    webex: {
      apiBase: env.WEBEX_API_BASE || 'https://webexapis.com/v1',
      accessToken: env.WEBEX_SERVICE_APP_ACCESS_TOKEN || '',
      clientId: env.WEBEX_CLIENT_ID || '',
      clientSecret: env.WEBEX_CLIENT_SECRET || '',
      refreshToken: env.WEBEX_REFRESH_TOKEN || '',
    },
    c2c: {
      destination: env.C2C_DESTINATION || '',
      guestName: env.C2C_GUEST_NAME || 'Web Caller',
      allowGuestName: bool(env.C2C_ALLOW_GUEST_NAME, true),
    },
    sdk: {
      version: env.WEBEX_SDK_VERSION || '3.12.0',
      region: env.WEBEX_REGION || '',
      country: env.WEBEX_COUNTRY || '',
    },
    server: {
      port: int(env.PORT, 3000),
      allowedOrigins: list(env.ALLOWED_ORIGINS),
      rateLimitMax: int(env.RATE_LIMIT_MAX, 5),
      rateLimitWindowMs: int(env.RATE_LIMIT_WINDOW_SECONDS, 600) * 1000,
      trustProxy: bool(env.TRUST_PROXY, false),
      diagnosticsKey: env.DIAGNOSTICS_KEY || '',
    },
  };

  const errors = [];
  const w = config.webex;
  const refreshParts = [w.clientId, w.clientSecret, w.refreshToken].filter(Boolean).length;
  if (refreshParts > 0 && refreshParts < 3) {
    errors.push('WEBEX_CLIENT_ID, WEBEX_CLIENT_SECRET and WEBEX_REFRESH_TOKEN must be set together');
  }
  if (refreshParts === 0 && !w.accessToken) {
    errors.push('Set WEBEX_SERVICE_APP_ACCESS_TOKEN, or WEBEX_CLIENT_ID + WEBEX_CLIENT_SECRET + WEBEX_REFRESH_TOKEN');
  }
  if (!config.c2c.destination) {
    errors.push('Set C2C_DESTINATION to the Customer Assist Call Queue / Auto Attendant number');
  }
  if (!/^\d+\.\d+\.\d+$/.test(config.sdk.version)) {
    errors.push('WEBEX_SDK_VERSION must be an exact version such as 3.12.0');
  }
  return { config, errors };
}
