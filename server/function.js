// Entry point for Google Cloud Run functions (and other Functions Framework
// hosts). Deploy with --entry-point=clickToCall. Configuration comes from
// environment variables / Secret Manager; there is no .env file in the cloud.
import { buildConfig, loadDotEnv } from './config.js';
import { createApp } from './app.js';
import { ServiceAppTokenProvider, WebexClient } from './webexClient.js';

loadDotEnv();
const { config, errors } = buildConfig();
if (errors.length) throw new Error('Configuration errors: ' + errors.join('; '));

const webex = new WebexClient(config.webex, new ServiceAppTokenProvider(config.webex));

export const clickToCall = createApp({ config, webex });
