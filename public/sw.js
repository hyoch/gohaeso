// Service worker: its only job is to show one of two fixed lines. It never caches pages and never touches the network.
// A push carries at most {"k":"letter"} or {"k":"duty"}, encrypted for this browser; no letter text ever travels.
const LINES = {
  letter: { body: '우체통에 편지가 도착했어요.', tag: 'letter', url: '/' },
  duty: { body: '누군가의 고해가 답장을 기다리고 있어요.', tag: 'duty', url: '/?go=reply' }
};
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let k = 'letter';
  try { const d = e.data && e.data.json(); if (d && LINES[d.k]) k = d.k; } catch (err) {}
  const L = LINES[k];
  e.waitUntil(self.registration.showNotification('작은 고해소', {
    body: L.body, tag: L.tag, icon: '/icon-192.png', badge: '/icon-192.png', data: { k }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const k = (e.notification.data && LINES[e.notification.data.k]) ? e.notification.data.k : 'letter';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.postMessage({ go: k === 'duty' ? 'reply' : 'mail' }); return c.focus(); } }
    return self.clients.openWindow(LINES[k].url);
  }));
});
