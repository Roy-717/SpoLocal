/**
 * PWA registration entry (built by Vite + vite-plugin-pwa).
 * Keeps the rest of the app on plain static scripts; only this file is bundled.
 */
import { registerSW } from 'virtual:pwa-register';

registerSW({ immediate: true });
