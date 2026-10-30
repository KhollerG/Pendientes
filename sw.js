// Permite que la app abra sin internet.
// Si cambias algún archivo, sube el número de versión (pendientes-v3, v4…).
const CACHE = "pendientes-v5";
const SHELL = ["./", "./index.html", "./app.js", "./firebase-config.js", "./manifest.webmanifest",
  "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

function put(req, res) { const c = res.clone(); caches.open(CACHE).then(x => x.put(req, c)); return res; }

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Archivos de la app: primero la red (para recibir cambios); sin internet, la copia guardada.
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(r => r.ok ? put(req, r) : r)
      .catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match("./index.html"))));
    return;
  }
  // Fuentes y librería de Firebase: primero la copia guardada.
  const staticHost = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com"
    || (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/"));
  if (staticHost) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => (r.ok || r.type === "opaque") ? put(req, r) : r)));
  }
  // Todo lo demás (la sincronización con Firebase) pasa directo, sin tocar.
});
