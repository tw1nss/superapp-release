/**
 * Service Worker for QR SLOC & MSLTC Generator MTG (Android PWA)
 */

const CACHE_NAME = 'superapp-mtg-pwa-v110';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css?v=109',
  './app.js?v=109',
  './qrcode.min.js',
  './manifest.json',
  './app-logo.jpg',
  './icon-192.png',
  './icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js'
];

// Install Event
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching app assets v108');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// Activate Event - Wipes all old caches immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] Removing old obsolete cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// Fetch Event (Network-First Strategy for Instant Live Updates)
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || event.request.url.includes('google.com') || event.request.url.includes('googleapis.com')) {
    return;
  }

  // Network-first: Always try network to get newest OTA changes
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // Fallback to cache if offline
        return caches.match(event.request);
      })
  );
});
