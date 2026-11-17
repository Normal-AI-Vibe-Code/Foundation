import 'dotenv/config';

import { App, LogLevel } from '@slack/bolt';

import { connectFoundation } from './foundation/bridge.js';
import { registerListeners } from './listeners/index.js';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.DEBUG,
  ignoreSelf: false,
});

connectFoundation(app);
registerListeners(app);

(async () => {
  await app.start();
  app.logger.info('Casey is running!');
})();
