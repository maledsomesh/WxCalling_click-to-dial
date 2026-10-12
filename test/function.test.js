import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { ServiceAppTokenProvider, WebexClient } from '../server/webexClient.js';
import { BASE_ENV, fakeWebexFetch } from './helpers.js';

// Simulates a Functions Framework (Express) request whose body was already parsed.
function invoke(handler, { body, headers = {} }) {
  const req = Object.assign(new EventEmitter(), {
    method: 'POST',
    url: '/api/c2c/session',
    headers: { host: 'c2c.run.app', origin: 'https://c2c.run.app', ...headers },
    body,
    socket: { remoteAddress: '10.0.0.1' },
  });
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      writeHead(status, h) { this.status = status; this.headers = h; this.headersSent = true; },
      end(payload) { resolve({ status: this.status, body: JSON.parse(payload) }); },
    };
    handler(req, res);
  });
}

test('works with a pre-parsed body (Cloud Run functions)', async () => {
  const fetchImpl = fakeWebexFetch();
  const { config } = buildConfig(BASE_ENV);
  const webex = new WebexClient(config.webex, new ServiceAppTokenProvider(config.webex, { fetchImpl }), { fetchImpl });
  const handler = createApp({ config, webex, logger: { info() {}, warn() {}, error() {} } });

  const res = await invoke(handler, { body: { name: 'Jane' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.guestName, 'Web Caller - Jane');
  assert.equal(res.body.callToken, 'jwe-abc');
});

test('function entry point exports the handler', async () => {
  Object.assign(process.env, BASE_ENV);
  const mod = await import('../server/function.js');
  assert.equal(typeof mod.clickToCall, 'function');
});
