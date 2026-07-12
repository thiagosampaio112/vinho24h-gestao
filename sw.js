/* Service Worker — cache do app (funciona offline / instalável).
   Ao publicar uma nova versão, aumente o número do CACHE. */
const CACHE = "vinho24h-gestao-v20";
const ARQUIVOS = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "planilha.js",
  "manifest.webmanifest",
  "icons/icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARQUIVOS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((chaves) =>
      Promise.all(chaves.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Nunca cacheia chamadas ao Apps Script (dados sempre frescos).
// Para o resto: rede primeiro, cai para o cache se estiver offline.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  if (e.request.url.includes("script.google.com")) return;
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        const copia = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia));
        return resp;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});
