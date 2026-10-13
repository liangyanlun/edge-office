const CACHE = "edge-office-shell-v10-ppt-workspace-storage";
const SHELL = ["/", "/index.html", "/styles.css?v=0.2.0-ui2", "/experience.css?v=0.2.0-ui2", "/app.js?v=0.2.0-ui2", "/experience.js?v=0.2.0-ui2", "/offline-runtime.js", "/native-bridge.js", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  // API responses and user documents must never enter the public app-shell cache.
  if (new URL(request.url).pathname.startsWith("/api/")) return;
  event.respondWith(fetch(request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy));
    return response;
  }).catch(() => caches.match(request).then((cached) => cached || caches.match("/index.html"))));
});
