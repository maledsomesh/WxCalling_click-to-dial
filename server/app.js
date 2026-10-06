// HTTP request handling: the click-to-call session API plus static hosting of
// the demo page and widget. No framework, so the flow is easy to port to the
// customer's own stack (Express, Fastify, Azure Functions, AWS Lambda, ...).
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RateLimiter } from './rateLimiter.js';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};
const MAX_BODY_BYTES = 4096;

// Visitor-supplied names are shown to agents, so keep them short and plain.
export function sanitizeName(input) {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} .'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

export function createApp({ config, webex, logger = console, limiter }) {
  const { server, c2c, sdk } = config;
  limiter ??= new RateLimiter({ max: server.rateLimitMax, windowMs: server.rateLimitWindowMs });

  const log = (level, msg, extra = {}) => logger[level](JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));

  function send(res, status, body, headers = {}) {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(payload);
  }

  // Behind N trusted proxies the real client is the Nth X-Forwarded-For entry
  // from the right. Entries further left are supplied by the client and can be
  // forged, so they must never be used for rate limiting.
  function clientIp(req) {
    const n = server.trustProxyHops;
    if (n > 0) {
      const ips = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (ips.length >= n) return ips[ips.length - n];
    }
    return req.socket?.remoteAddress || 'unknown';
  }

  // Same-origin requests are always allowed; cross-origin only from ALLOWED_ORIGINS.
  function originCheck(req) {
    const origin = req.headers.origin;
    if (!origin) return { ok: false };
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === req.headers.host;
    } catch {
      return { ok: false };
    }
    if (sameOrigin) return { ok: true, cors: {} };
    if (server.allowedOrigins.includes(origin)) {
      return {
        ok: true,
        cors: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600',
          Vary: 'Origin',
        },
      };
    }
    return { ok: false };
  }

  async function readJson(req) {
    // Hosts such as Google Cloud Run functions (Functions Framework / Express)
    // have already parsed the body and consumed the stream.
    if (req.body !== undefined) {
      if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
        if (req.body.length > MAX_BODY_BYTES) throw Object.assign(new Error('Body too large'), { status: 413, expose: true });
        try {
          return req.body.length ? JSON.parse(req.body.toString()) : {};
        } catch {
          throw Object.assign(new Error('Invalid JSON'), { status: 400, expose: true });
        }
      }
      return req.body && typeof req.body === 'object' ? req.body : {};
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Body too large'), { status: 413, expose: true });
      chunks.push(chunk);
    }
    if (!size) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw Object.assign(new Error('Invalid JSON'), { status: 400, expose: true });
    }
  }

  // POST /api/c2c/session -> { guestToken, callToken, guestName, ... }
  // The destination comes from server config only; the browser cannot change it.
  async function createSession(req, res, cors) {
    const ip = clientIp(req);
    const rl = limiter.take(ip);
    if (!rl.allowed) {
      log('warn', 'rate limited', { ip });
      return send(res, 429, { error: 'Too many call attempts. Please try again later.' }, { ...cors, 'Retry-After': String(rl.retryAfterSeconds) });
    }

    const body = await readJson(req);
    const visitorName = c2c.allowGuestName ? sanitizeName(body.name) : '';
    const guestName = visitorName ? `${c2c.guestName} - ${visitorName}` : c2c.guestName;
    const sessionId = randomUUID();

    const [guest, callToken] = await Promise.all([
      webex.createGuestToken({ subject: `c2c-${sessionId}`, displayName: guestName }),
      webex.createCallToken({ calledNumber: c2c.destination, guestName }),
    ]);

    log('info', 'session created', { sessionId, ip });
    return send(
      res,
      200,
      {
        sessionId,
        guestName,
        guestToken: guest.accessToken,
        guestTokenExpiresIn: guest.expiresIn,
        callToken,
        sdk: { region: sdk.region, country: sdk.country },
      },
      cors,
    );
  }

  // GET /api/diagnostics (header X-Diagnostics-Key) - checks every Webex step
  // and reports which one fails, without returning any token values.
  async function diagnostics(req, res) {
    if (!server.diagnosticsKey) return send(res, 404, { error: 'Not found' });
    if (req.headers['x-diagnostics-key'] !== server.diagnosticsKey) return send(res, 401, { error: 'Unauthorized' });
    send(res, 200, await runDiagnostics({ config, webex }));
  }

  async function serveStatic(req, res, pathname) {
    const rel = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
    const file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + sep)) return send(res, 404, 'Not found');
    try {
      if (!(await stat(file)).isFile()) return send(res, 404, 'Not found');
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        // Microphone is needed by the call widget on this origin only.
        'Permissions-Policy': 'microphone=(self), camera=()',
      });
      res.end(data);
    } catch {
      send(res, 404, 'Not found');
    }
  }

  return async function handler(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (pathname === '/healthz') return send(res, 200, { status: 'ok' });

      if (pathname === '/api/config' && req.method === 'GET') {
        return send(res, 200, { sdkVersion: sdk.version, allowGuestName: c2c.allowGuestName });
      }

      if (pathname === '/api/c2c/session') {
        const oc = originCheck(req);
        if (!oc.ok) return send(res, 403, { error: 'Origin not allowed' });
        if (req.method === 'OPTIONS') return send(res, 204, '', oc.cors);
        if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' }, oc.cors);
        return await createSession(req, res, oc.cors);
      }

      if (pathname === '/api/diagnostics' && req.method === 'GET') return await diagnostics(req, res);

      if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, pathname);
      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      // Only our own request-validation errors are shown to the browser; Webex
      // failures are logged with their trackingId and reported generically.
      const status = err.expose ? err.status : 502;
      log('error', err.message, { path: pathname, webexStatus: err.expose ? undefined : err.status, trackingId: err.trackingId });
      if (!res.headersSent) {
        send(res, status, { error: status === 502 ? 'The call service is unavailable. Please try again later.' : err.message });
      }
    }
  };
}

// Shared by the diagnostics endpoint and `npm run check`.
export async function runDiagnostics({ config, webex }) {
  const steps = [];
  const step = async (name, fn) => {
    try {
      const detail = await fn();
      steps.push({ step: name, ok: true, ...(detail && { detail }) });
      return true;
    } catch (err) {
      steps.push({ step: name, ok: false, status: err.status, error: err.message, trackingId: err.trackingId });
      return false;
    }
  };

  const mode = webex.tokens.canRefresh ? 'refresh-token (auto renew)' : 'static access token';
  const tokenOk = await step('Service App access token', async () => {
    const t = await webex.tokens.getToken();
    if (!t) throw new Error('No token configured');
    return mode;
  });
  if (tokenOk) {
    await step('Guest token  (POST /v1/guests/token)', async () => {
      const g = await webex.createGuestToken({ subject: `c2c-diagnostics-${randomUUID()}`, displayName: 'Diagnostics' });
      return `expiresIn=${g.expiresIn ?? 'n/a'}s`;
    });
    await step('Call token   (POST /v1/telephony/click2call/callToken)', async () => {
      await webex.createCallToken({ calledNumber: config.c2c.destination, guestName: 'Diagnostics' });
      return `destination=${config.c2c.destination}`;
    });
  }
  return { ok: steps.every((s) => s.ok), steps };
}
