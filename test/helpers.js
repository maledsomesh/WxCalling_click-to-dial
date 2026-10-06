import { createServer } from 'node:http';
import { buildConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { ServiceAppTokenProvider, WebexClient } from '../server/webexClient.js';

// Fake Webex API: records requests and answers like the real endpoints.
export function fakeWebexFetch(overrides = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : Object.fromEntries(init.body ?? []);
    calls.push({ path, headers: init.headers, body });
    const handler = overrides[path];
    if (handler) return handler(body, init);
    if (path === '/v1/guests/token') return json(200, { accessToken: 'guest-token-123', expiresIn: 7200 });
    if (path === '/v1/telephony/click2call/callToken') return json(200, { callToken: 'jwe-abc' });
    if (path === '/v1/access_token') return json(200, { access_token: 'refreshed-token', expires_in: 3600 });
    return json(404, { message: 'not found' });
  };
  fn.calls = calls;
  return fn;
}

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export const BASE_ENV = {
  WEBEX_SERVICE_APP_ACCESS_TOKEN: 'service-app-token',
  C2C_DESTINATION: '+15551234567',
  C2C_GUEST_NAME: 'Web Caller',
  DIAGNOSTICS_KEY: 'diag-secret',
};

export async function startTestServer({ env = {}, fetchImpl = fakeWebexFetch() } = {}) {
  const { config, errors } = buildConfig({ ...BASE_ENV, ...env });
  if (errors.length) throw new Error(errors.join('; '));
  const webex = new WebexClient(config.webex, new ServiceAppTokenProvider(config.webex, { fetchImpl }), { fetchImpl });
  const logs = [];
  const logger = { info: (l) => logs.push(l), warn: (l) => logs.push(l), error: (l) => logs.push(l) };
  const server = createServer(createApp({ config, webex, logger }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, server, fetchImpl, logs, close: () => new Promise((r) => server.close(r)) };
}
