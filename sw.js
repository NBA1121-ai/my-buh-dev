const CACHE_NAME = 'buh-offline-v3';
const BASE = '/my-buh-dev/';
const ASSETS = [
    BASE,
    BASE + 'index.html',
    BASE + 'app.html',
    BASE + 'css/app.css',
    BASE + 'js/db-sync.js',
    BASE + 'js/utils.js',
    BASE + 'manifest.json'
];
const CDN_ASSETS = [
    'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS).then(() => {
                const cdnPromises = CDN_ASSETS.map((url) =>
                    fetch(url, { mode: 'cors' })
                        .then((resp) => {
                            if (resp.ok) return cache.put(url, resp);
                        })
                        .catch(() => {})
                );
                return Promise.all(cdnPromises);
            });
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // GitHub API requests — network only (data sync)
    if (url.hostname === 'api.github.com' || url.hostname === 'raw.githubusercontent.com') {
        return;
    }

    // HTML, CSS, JS, CDN — cache first, then network
    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) {
                // Update cache in background
                fetch(event.request).then((resp) => {
                    if (resp && resp.ok) {
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, resp);
                        });
                    }
                }).catch(() => {});
                return cached;
            }
            return fetch(event.request).then((resp) => {
                if (resp && resp.ok) {
                    const clone = resp.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, clone);
                    });
                }
                return resp;
            });
        })
    );
});
