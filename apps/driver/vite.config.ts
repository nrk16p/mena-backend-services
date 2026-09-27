/// <reference types="vitest/config" />
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss(), basicSsl()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: { port: 5174, host: true, proxy: { '/api': 'http://localhost:3000' }, fs: { allow: [path.resolve(__dirname, '..')] } },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
});
