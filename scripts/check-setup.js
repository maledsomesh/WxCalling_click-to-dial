// `npm run check` - validates .env and calls each Webex API the solution needs,
// telling you exactly which setup step is missing. Run this before testing in a browser.
import { buildConfig, loadDotEnv } from '../server/config.js';
import { runDiagnostics } from '../server/app.js';
import { ServiceAppTokenProvider, WebexClient } from '../server/webexClient.js';

const HINTS = {
  'Service App access token':
    'Check the Service App token / client credentials. Was the Service App authorised by a full admin in Control Hub?',
  'Guest token': 'Service App needs the guest-issuer:write and guest-issuer:read scopes.',
  'Call token':
    'Click-to-call must be enabled in Control Hub (Customer Assist license), the Service App needs the click-to-call scope, and C2C_DESTINATION must be a click-to-call enabled Customer Assist queue / auto attendant number.',
};

loadDotEnv();
const { config, errors } = buildConfig();
if (errors.length) {
  console.error('✗ Configuration errors:\n  - ' + errors.join('\n  - '));
  process.exit(1);
}
console.log('✓ .env configuration is complete\n');

const webex = new WebexClient(config.webex, new ServiceAppTokenProvider(config.webex));
const result = await runDiagnostics({ config, webex });
for (const s of result.steps) {
  if (s.ok) {
    console.log(`✓ ${s.step}${s.detail ? `  [${s.detail}]` : ''}`);
  } else {
    console.log(`✗ ${s.step}\n    ${s.error}${s.trackingId ? `\n    Webex trackingId: ${s.trackingId}` : ''}`);
    const hint =
      s.status === 401
        ? 'The Service App access token is invalid or expired. Regenerate it in the Developer Portal, or configure the refresh-token option.'
        : s.status === undefined && !s.trackingId
          ? 'Network problem: check this server can reach https://webexapis.com (proxy / firewall egress rules).'
          : Object.entries(HINTS).find(([k]) => s.step.startsWith(k))?.[1];
    if (hint) console.log(`    Hint: ${hint}`);
  }
}
console.log(result.ok ? '\nAll checks passed - start the server with `npm start` and place a test call.' : '\nFix the failed step above and run `npm run check` again.');
process.exit(result.ok ? 0 : 1);
