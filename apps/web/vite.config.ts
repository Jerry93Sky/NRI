import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000';
export default defineConfig({ plugins: [react()], server: { host: '127.0.0.1', proxy: { '/api': apiTarget, '/socket.io': { target: apiTarget.replace('http', 'ws'), ws: true } } }, test: { environment: 'node' } });
