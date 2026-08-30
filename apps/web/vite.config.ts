import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const runtimeOrigin = env.RUNTIME_ORIGIN?.trim() || `http://127.0.0.1:${env.PORT || '3000'}`;
  const webPort = Number(env.WEB_PORT || '5173');
  if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65_535) {
    throw new Error(`Invalid WEB_PORT: ${env.WEB_PORT}`);
  }

  return {
    root: 'apps/web',
    publicDir: '../../public',
    plugins: [react(), tailwindcss()],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            return id.includes('react-markdown') || id.includes('remark-gfm') || id.includes('node_modules/remark-')
              ? 'markdown'
              : undefined;
          },
        },
      },
    },
    server: {
      port: webPort,
      strictPort: true,
      proxy: {
        '/api': runtimeOrigin,
        '/mcp': runtimeOrigin,
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});
