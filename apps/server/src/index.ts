import { port } from './config/runtime.js';
import { createApp } from './app.js';
import { errorCategory } from './security/logging.js';

const traceStartup = process.env.NODE_ENV === 'test' && process.env.NRI_RESTART_TRACE === '1';
try {
  if (traceStartup) console.info(JSON.stringify({ phase: 'modules-loaded', pid: process.pid, parentPid: process.ppid }));
  const app = await createApp();
  if (traceStartup) console.info(JSON.stringify({ phase: 'routes-and-realtime-initialized', pid: process.pid }));
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'Stopping NRI API');
      void app.close().catch(() => {
        app.log.error('NRI API shutdown failed');
        process.exitCode = 1;
      });
    });
  }
  if (traceStartup) console.info(JSON.stringify({ phase: 'binding-http', pid: process.pid, port }));
  await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
  app.log.info({ port }, 'NRI API listening');
} catch (error) {
  console.error('NRI API startup failed', { category: errorCategory(error) });
  process.exitCode = 1;
}
