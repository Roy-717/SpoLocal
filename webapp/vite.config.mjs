/**
 * Local-only PWA build (Vite + vite-plugin-pwa).
 * Outputs service worker + tiny registration bundle under static/pwa/.
 */
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    root: __dirname,
    base: '/static/pwa/',
    build: {
        outDir: path.join(__dirname, 'static', 'pwa'),
        emptyOutDir: true,
        rollupOptions: {
            input: path.join(__dirname, 'pwa-entry.js'),
            output: {
                entryFileNames: 'pwa-entry.js',
                chunkFileNames: 'chunks/[name]-[hash].js',
                assetFileNames: 'assets/[name]-[hash][extname]',
            },
        },
    },
    plugins: [
        VitePWA({
            strategies: 'generateSW',
            registerType: 'autoUpdate',
            injectRegister: null,
            manifest: false,
            filename: 'sw.js',
            scope: '/',
            devOptions: {
                enabled: true,
                type: 'module',
            },
            workbox: {
                cleanupOutdatedCaches: true,
                navigateFallback: null,
                runtimeCaching: [
                    {
                        urlPattern: ({ url }) =>
                            url.origin === self.location.origin &&
                            url.pathname.startsWith('/static/') &&
                            !url.pathname.startsWith('/static/pwa/'),
                        handler: 'StaleWhileRevalidate',
                        options: {
                            cacheName: 'spolocal-static-assets',
                            expiration: {
                                maxEntries: 120,
                                maxAgeSeconds: 60 * 60 * 24 * 30,
                            },
                        },
                    },
                ],
            },
        }),
    ],
    server: {
        proxy: {
            '/api': 'http://localhost:8000',
            '/static': 'http://localhost:8000',
        },
    },
});
