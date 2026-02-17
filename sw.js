const CACHE_NAME = 'gcode-viewer-v3';
const ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/gcode-parser.js',
  '/js/viewer.js',
  '/js/app.js',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k !== CACHE_NAME)
        .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Handle shared files from Android "Share to" / "Open with"
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Intercept the share target POST
  if (url.pathname === '/share' && event.request.method === 'POST') {
    event.respondWith(
      (async () => {
        const formData = await event.request.formData();
        const file = formData.get('file');

        // Store the shared file in a temporary cache for the page to pick up
        const fileCache = await caches.open('shared-files');
        await fileCache.put('/shared-file-data', new Response(file, {
          headers: {
            'Content-Type': 'text/plain',
            'X-File-Name': file.name || 'shared.nc'
          }
        }));

        // Redirect to the app with a flag
        return Response.redirect('/?shared=1', 303);
      })()
    );
    return;
  }

  // CDN resources — network first, cache fallback
  if (url.hostname !== location.hostname) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // App assets — network first so updates are picked up, cache fallback
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
