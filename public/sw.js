// Service Worker nur für Benachrichtigungen (Trink-Erinnerung). Kein Offline-Cache,
// damit nach einem Deployment sofort die neue Version geladen wird.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (ev) => ev.waitUntil(self.clients.claim()));

// Tippen auf die Benachrichtigung öffnet die App (oder holt sie nach vorn).
self.addEventListener('notificationclick', (ev) => {
  ev.notification.close();
  ev.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (win) return win.focus();
    return self.clients.openWindow(self.registration.scope + '#liter');
  })());
});
