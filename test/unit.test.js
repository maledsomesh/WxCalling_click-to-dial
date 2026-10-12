import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../server/config.js';
import { sanitizeName } from '../server/app.js';
import { RateLimiter } from '../server/rateLimiter.js';
import { ServiceAppTokenProvider } from '../server/webexClient.js';
import { fakeWebexFetch } from './helpers.js';

test('config: reports missing credentials and destination', () => {
  const { errors } = buildConfig({});
  assert.equal(errors.length, 2);
});

test('config: refresh credentials must be complete', () => {
  const { errors } = buildConfig({ WEBEX_CLIENT_ID: 'x', C2C_DESTINATION: '1' });
  assert.match(errors.join(), /must be set together/);
});

test('config: SDK version must be pinned', () => {
  const { errors } = buildConfig({ WEBEX_SERVICE_APP_ACCESS_TOKEN: 't', C2C_DESTINATION: '1', WEBEX_SDK_VERSION: 'latest' });
  assert.match(errors.join(), /exact version/);
});

test('sanitizeName strips markup and limits length', () => {
  assert.equal(sanitizeName('  <b>José</b>  O\'Neil '), "bJoséb O'Neil");
  assert.equal(sanitizeName('x'.repeat(100)).length, 40);
  assert.equal(sanitizeName(42), '');
});

test('rate limiter resets after the window', () => {
  let now = 0;
  const rl = new RateLimiter({ max: 1, windowMs: 1000, now: () => now });
  assert.equal(rl.take('a').allowed, true);
  assert.equal(rl.take('a').allowed, false);
  assert.equal(rl.take('b').allowed, true);
  now = 1000;
  assert.equal(rl.take('a').allowed, true);
});

test('token provider: static token when no refresh credentials', async () => {
  const p = new ServiceAppTokenProvider({ accessToken: 'static', apiBase: 'https://webexapis.com/v1' });
  assert.equal(await p.getToken(), 'static');
});

test('token provider: refreshes once, caches, and renews before expiry', async () => {
  let now = 0;
  const fetchImpl = fakeWebexFetch();
  const p = new ServiceAppTokenProvider(
    { apiBase: 'https://webexapis.com/v1', clientId: 'id', clientSecret: 'secret', refreshToken: 'rt' },
    { fetchImpl, now: () => now },
  );
  const [a, b] = await Promise.all([p.getToken(), p.getToken()]);
  assert.equal(a, 'refreshed-token');
  assert.equal(b, 'refreshed-token');
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(fetchImpl.calls[0].body, { grant_type: 'refresh_token', client_id: 'id', client_secret: 'secret', refresh_token: 'rt' });
  now = 3600 * 1000 - 4 * 60 * 1000; // inside the 5-minute renewal margin
  await p.getToken();
  assert.equal(fetchImpl.calls.length, 2);
});
