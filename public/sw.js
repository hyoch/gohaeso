// Service worker: its only job is to show "a letter has arrived". It never caches pages and never touches the network.
// The push itself carries no text; this fixed line is all that is ever shown.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  e.waitUntil(self.registration.showNotification('작은 고해소', {
    body: '우체통에 편지가 도착했어요.',
    tag: 'letter', icon: '/icon-192.png', badge: '/icon-192.png'
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('/');
  }));
});
