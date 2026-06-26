const CACHE_NAME = "ghostcall-v6";
const APP_SHELL = [
  "/",
  "/static/index.html",
  "/static/styles.css",
  "/static/app.js",
  "/static/favicon.svg",
  "/static/offline.html",
  "/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/static/offline.html")));
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request)),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = {};
    }
  }

  const title = data.title || "Incoming GhostCall";
  const options = {
    body: data.body || "Incoming call",
    icon: "/static/favicon.svg",
    badge: "/static/favicon.svg",
    tag: data.call_id || "ghostcall-incoming",
    data: {
      url: data.url || "/",
      call_id: data.call_id || null,
      caller: data.caller || null,
    },
    requireInteraction: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.postMessage({ type: "notification_clicked", caller: event.notification.data?.caller || null });
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});
