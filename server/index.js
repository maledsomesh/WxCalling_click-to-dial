// Entry point: load config, wire dependencies, start the HTTP server.
import { createServer } from 'node:http';
import { buildConfig, loadDotEnv } from './config.js';
import { createApp } from './app.js';
import { ServiceAppTokenProvider, WebexClient } from './webexClient.js';

loadDotEnv();
const { config, errors } = buildConfig();
if (errors.length) {
  console.error('Configuration errors:\n  - ' + errors.join('\n  - ') + '\nSee .env.example');
  process.exit(1);
}

const tokens = new ServiceAppTokenProvider(config.webex);
const webex = new WebexClient(config.webex, tokens);
const server = createServer(createApp({ config, webex }));

server.listen(config.server.port, () => {
  console.log(`Click-to-call server listening on http://localhost:${config.server.port}`);
  console.log(`  destination: ${config.c2c.destination}   token mode: ${tokens.canRefresh ? 'refresh' : 'static'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
