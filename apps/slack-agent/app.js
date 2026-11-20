import 'dotenv/config';

import { App } from '@slack/bolt';

import { LOG_LEVEL_NAME, logLevelFrom } from './config/settings.js';
import { connectFoundation } from './foundation/bridge.js';
import { registerListeners } from './listeners/index.js';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: logLevelFrom(process.env[LOG_LEVEL_NAME]),
  ignoreSelf: false,
});

connectFoundation(app);
registerListeners(app);

(async () => {
  await app.start();
  app.logger.info('Casey is running!');
})();
