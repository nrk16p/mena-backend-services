/// <reference types="vitest/config" />
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3000' }, fs: { allow: [path.resolve(__dirname, '..')] } },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}', '../shared/**/*.test.ts'] },
});
