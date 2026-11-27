import { port } from './config/runtime.js';
import { createApp } from './app.js';
import { errorCategory } from './security/logging.js';

try {
  const app = await createApp();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'Stopping NRI API');
      void app.close().catch(() => {
        app.log.error('NRI API shutdown failed');
        process.exitCode = 1;
      });
    });
  }
  await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
  app.log.info({ port }, 'NRI API listening');
} catch (error) {
  console.error('NRI API startup failed', { category: errorCategory(error) });
  process.exitCode = 1;
}
