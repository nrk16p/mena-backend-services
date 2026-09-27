/// <reference types="vitest/config" />
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    basicSsl(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'Mena Driver',
        short_name: 'Mena Driver',
        lang: 'th',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f5f5f5',
        theme_color: '#1d4ed8',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: { navigateFallback: '/index.html', navigateFallbackDenylist: [/^\/api\//], runtimeCaching: [] },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: { port: 5174, host: true, proxy: { '/api': 'http://localhost:3000' }, fs: { allow: [path.resolve(__dirname, '..')] } },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}', '../shared/**/*.test.ts'] },
});
