#!/usr/bin/env node
import { createConsoleServer } from './server.js';

const app = createConsoleServer();
const address = await app.listen(Number(process.env.VIBE_ONE_CONSOLE_PORT) || 4174);
console.log(`Vibe-one console: ${address.url}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
