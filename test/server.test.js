import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeWebexFetch, json, startTestServer } from './helpers.js';

const post = (base, body, headers = {}) =>
  fetch(`${base}/api/c2c/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, ...headers },
    body: JSON.stringify(body),
  });

test('creates a session with guest + call tokens and a server-side destination', async () => {
  const t = await startTestServer();
  try {
    const res = await post(t.base, { name: 'Jane <script>' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.guestToken, 'guest-token-123');
    assert.equal(body.callToken, 'jwe-abc');
    assert.equal(body.guestName, 'Web Caller - Jane script');

    const callTokenReq = t.fetchImpl.calls.find((c) => c.path === '/v1/telephony/click2call/callToken');
    assert.deepEqual(callTokenReq.body, { calledNumber: '+15551234567', guestName: 'Web Caller - Jane script' });
    assert.equal(callTokenReq.headers.Authorization, 'Bearer service-app-token');
    const guestReq = t.fetchImpl.calls.find((c) => c.path === '/v1/guests/token');
    assert.match(guestReq.body.subject, /^c2c-[0-9a-f-]{36}$/);
    // Service App token never returned to the browser.
    assert.ok(!JSON.stringify(body).includes('service-app-token'));
  } finally {
    await t.close();
  }
});

test('ignores any destination the browser tries to send', async () => {
  const t = await startTestServer();
  try {
    await post(t.base, { calledNumber: '+19005550000', destination: '+19005550000' });
    const req = t.fetchImpl.calls.find((c) => c.path === '/v1/telephony/click2call/callToken');
    assert.equal(req.body.calledNumber, '+15551234567');
  } finally {
    await t.close();
  }
});

test('visitor names are ignored when C2C_ALLOW_GUEST_NAME=false', async () => {
  const t = await startTestServer({ env: { C2C_ALLOW_GUEST_NAME: 'false' } });
  try {
    const body = await (await post(t.base, { name: 'Jane' })).json();
    assert.equal(body.guestName, 'Web Caller');
  } finally {
    await t.close();
  }
});

test('rejects requests without an allowed Origin', async () => {
  const t = await startTestServer();
  try {
    assert.equal((await post(t.base, {}, { Origin: 'https://evil.example' })).status, 403);
    const noOrigin = await fetch(`${t.base}/api/c2c/session`, { method: 'POST' });
    assert.equal(noOrigin.status, 403);
    assert.equal(t.fetchImpl.calls.length, 0);
  } finally {
    await t.close();
  }
});

test('allows configured cross-origin sites with CORS headers and preflight', async () => {
  const t = await startTestServer({ env: { ALLOWED_ORIGINS: 'https://www.customer.example' } });
  try {
    const pre = await fetch(`${t.base}/api/c2c/session`, { method: 'OPTIONS', headers: { Origin: 'https://www.customer.example' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://www.customer.example');
    const res = await post(t.base, {}, { Origin: 'https://www.customer.example' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://www.customer.example');
  } finally {
    await t.close();
  }
});

test('rate limits call sessions per IP', async () => {
  const t = await startTestServer({ env: { RATE_LIMIT_MAX: '2' } });
  try {
    assert.equal((await post(t.base, {})).status, 200);
    assert.equal((await post(t.base, {})).status, 200);
    const third = await post(t.base, {});
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) > 0);
  } finally {
    await t.close();
  }
});

test('Webex failures return a generic 502 and log the trackingId', async () => {
  const fetchImpl = fakeWebexFetch({
    '/v1/telephony/click2call/callToken': () => json(403, { message: 'Click to call not enabled' }, { trackingid: 'ROUTER_123' }),
  });
  const t = await startTestServer({ fetchImpl });
  try {
    const res = await post(t.base, {});
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.ok(!body.error.includes('Click to call not enabled'));
    assert.ok(t.logs.some((l) => l.includes('ROUTER_123') && l.includes('Click to call not enabled')));
  } finally {
    await t.close();
  }
});

test('invalid JSON is a 400', async () => {
  const t = await startTestServer();
  try {
    const res = await fetch(`${t.base}/api/c2c/session`, { method: 'POST', headers: { Origin: t.base }, body: '{nope' });
    assert.equal(res.status, 400);
  } finally {
    await t.close();
  }
});

test('diagnostics requires the key and reports each step', async () => {
  const t = await startTestServer();
  try {
    assert.equal((await fetch(`${t.base}/api/diagnostics`)).status, 401);
    const res = await fetch(`${t.base}/api/diagnostics`, { headers: { 'X-Diagnostics-Key': 'diag-secret' } });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.steps.length, 3);
    assert.ok(!JSON.stringify(body).includes('jwe-abc'));
  } finally {
    await t.close();
  }
});

test('diagnostics is disabled without DIAGNOSTICS_KEY', async () => {
  const t = await startTestServer({ env: { DIAGNOSTICS_KEY: '' } });
  try {
    assert.equal((await fetch(`${t.base}/api/diagnostics`)).status, 404);
  } finally {
    await t.close();
  }
});

test('serves the widget and blocks path traversal', async () => {
  const t = await startTestServer();
  try {
    const page = await fetch(`${t.base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /c2c-widget\.js/);
    assert.equal((await fetch(`${t.base}/c2c-widget.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await fetch(`${t.base}/..%2fpackage.json`)).status, 404);
    assert.equal((await fetch(`${t.base}/%2e%2e/.env.example`)).status, 404);
    const cfg = await (await fetch(`${t.base}/api/config`)).json();
    assert.deepEqual(cfg, { sdkVersion: '3.12.0', allowGuestName: true });
  } finally {
    await t.close();
  }
});
