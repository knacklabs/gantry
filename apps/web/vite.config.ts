import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

const coreOrigin = process.env.GANTRY_LOCAL_CORE_ORIGIN;

export default defineConfig({
  base: '/ui/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: process.env.GANTRY_CONTROL_HOST || '127.0.0.1',
    port: Number(process.env.GANTRY_CONTROL_PORT || 3939),
    strictPort: true,
    ...(coreOrigin && {
      proxy: Object.fromEntries(
        ['/ui/api', '/ui/auth', '/auth', '/v1', '/healthz', '/readyz', '/metrics'].map(
          (route) => [route, { target: coreOrigin, changeOrigin: false }],
        ),
      ),
    }),
  },
});
