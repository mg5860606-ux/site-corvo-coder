// Corvo Coder - Service Worker v2.0
const CACHE_NAME = 'corvo-coder-v2';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/css/vscode.css',
  '/css/workspace.css',
  '/js/app.js',
  '/js/vscode.js',
  '/js/workspace.js',
  '/logo.jpg',
  '/fundo.jpg',
  '/favicon.svg',
  '/manifest.json',
  '/pages/login.html',
  '/pages/signup.html',
  '/pages/settings.html',
  '/pages/billing.html',
  '/pages/vscode.html',
  '/admin/index.html'
];

// Install - cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.log('[SW] Alguns assets não puderam ser cacheados:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Activate - clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch - serve from cache first, network fallback
self.addEventListener('fetch', (event) => {
  // Skip API requests - don't cache them
  if (event.request.url.includes('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Cache-first strategy for static assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      // Return cached version immediately, then update in background
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Network failed, return cached
        return cached;
      });

      return cached || fetchPromise;
    })
  );
});

// Message handler
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
