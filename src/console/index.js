#!/usr/bin/env node
import { createConsoleServer } from './server.js';

const app = createConsoleServer();
const address = await app.listen(Number(process.env.FRONTEND_AUTOPILOT_CONSOLE_PORT) || 4174);
console.log(`Frontend Autopilot console: ${address.url}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
