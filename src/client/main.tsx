import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from 'react-query';
import { ReactQueryDevtools } from 'react-query/devtools';

import App from './App';
import { initializeMediaSession } from './services/media-session';
import { initializeKeyboardShortcuts } from './services/keyboard-shortcuts';
import { initializeOfflineStorage } from './services/offline-storage';
import { logger } from './utils/logger';
import ErrorBoundary from './components/common/ErrorBoundary';

import './styles/globals.css';

// Create React Query client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 30000),
      staleTime: 5 * 60 * 1000, // 5 minutes
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 1,
    },
  },
});

// Initialize services
const initializeServices = async () => {
  try {
    await initializeOfflineStorage();
    await initializeMediaSession();
    await initializeKeyboardShortcuts();
    
    logger.info('Services initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize services:', error);
  }
};

// Main app initialization
const initializeApp = async () => {
  try {
    const rootElement = document.getElementById('root');
    if (!rootElement) {
      throw new Error('Root element not found');
    }

    // Initialize services
    await initializeServices();

    // Create React root
    const root = createRoot(rootElement);

    // Render app
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <BrowserRouter>
              <App />
            </BrowserRouter>
            {process.env.NODE_ENV === 'development' && <ReactQueryDevtools />}
          </QueryClientProvider>
        </ErrorBoundary>
      </React.StrictMode>
    );

    // Remove loading screen
    document.body.classList.add('app-ready');
    
    logger.info('App initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize app:', error);
    
    // Show error message to user
    const rootElement = document.getElementById('root');
    if (rootElement) {
      rootElement.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; padding: 20px; text-align: center;">
          <h1 style="color: #ff4444; margin-bottom: 10px;">Failed to load application</h1>
          <p style="color: #666666; margin-bottom: 20px;">Please refresh the page to try again.</p>
          <button 
            onclick="window.location.reload()" 
            style="padding: 10px 20px; background-color: #8f23e8; color: white; border: none; border-radius: 4px; cursor: pointer;"
          >
            Refresh Page
          </button>
        </div>
      `;
    }
  }
};

// Start the app
initializeApp();

// Handle service worker updates
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Show update available notification
    logger.info('App update available');
  });
}

// Handle app visibility changes
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    logger.debug('App hidden');
  } else {
    logger.debug('App visible');
  }
});

// Handle online/offline status
window.addEventListener('online', () => {
  logger.info('App online');
});

window.addEventListener('offline', () => {
  logger.info('App offline');
});

// Handle unhandled promise rejections
window.addEventListener('unhandledrejection', (event) => {
  logger.error('Unhandled promise rejection:', event.reason);
});

// Handle global errors
window.addEventListener('error', (event) => {
  logger.error('Global error:', event.error);
});