import { port } from './config/runtime.js';
import { createApp } from './app.js';

const app = await createApp();
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
app.log.info({ port }, 'NRI API listening');
