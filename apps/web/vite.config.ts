import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const controlTarget = 'http://127.0.0.1:3939';

function localControlProxy() {
  return {
    target: controlTarget,
    changeOrigin: true,
    configure(proxy: {
      on: (
        event: 'proxyReq',
        listener: (proxyRequest: {
          setHeader: (name: string, value: string) => void;
        }) => void,
      ) => void;
    }) {
      proxy.on('proxyReq', (proxyRequest) => {
        proxyRequest.setHeader('origin', controlTarget);
      });
    },
  };
}

export default defineConfig({
  base: '/ui/',
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '127.0.0.1',
    hmr: false,
    port: 5173,
    proxy: {
      '/ui/runtime-config.json': localControlProxy(),
      '/ui-api': localControlProxy(),
    },
    strictPort: true,
  },
});
