// Mailbox client for the real site. Talks to /api/* on the same origin.
// Identity is a random "mailbox key" kept in this browser instead of a login. The server never stores the key itself.
// In the Claude preview this file does not exist and the page stays a preview.
(() => {
  const KEY = 'gohaeso.key', OK = /^[A-Za-z0-9_-]{43}$/;
  let key = null;
  try { const k = localStorage.getItem(KEY); if (OK.test(k || '')) key = k; } catch (e) {}
  const mint = () => {
    const b = crypto.getRandomValues(new Uint8Array(32)); let s = '';
    b.forEach(x => { s += String.fromCharCode(x); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const API = {
    live: false,
    hasKey: () => !!key,
    getKey: () => key,
    setKey(k) { if (!OK.test(k || '')) return false; key = k; try { localStorage.setItem(KEY, k); } catch (e) {} return true; },
    dropKey() { key = null; try { localStorage.removeItem(KEY); } catch (e) {} },
    async health() {
      try { const r = await fetch('/api/health', { cache: 'no-store', credentials: 'omit' }); return r.ok ? await r.json() : null; } catch (e) { return null; }
    },
    async call(method, path, body) {
      if (!key) { key = mint(); try { localStorage.setItem(KEY, key); } catch (e) {} }
      try {
        const r = await fetch('/api/' + path, {
          method, cache: 'no-store', credentials: 'omit',
          headers: Object.assign({ authorization: 'Bearer ' + key }, body === undefined ? {} : { 'content-type': 'application/json' }),
          body: body === undefined ? undefined : JSON.stringify(body)
        });
        let d = {}; try { d = await r.json(); } catch (e) {}
        return { ok: r.ok, status: r.status, data: d };
      } catch (e) { return { ok: false, status: 0, data: { error: 'network' } }; }
    }
  };
  /* letter-arrived notifications (Web Push). The push itself carries no text. */
  const toBytes = b => { const p = b.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b.length + 3) % 4); const r = atob(p); return Uint8Array.from(r, c => c.charCodeAt(0)); };
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator.standalone || (matchMedia && matchMedia('(display-mode: standalone)').matches));
  API.push = {
    supported: () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
    needsInstall: () => ios,                                    // iPhone only allows notifications for sites added to the Home Screen
    async state() {
      if (!API.push.supported()) return ios ? 'install' : 'unsupported';
      if (Notification.permission === 'denied') return 'denied';
      try {
        const reg = await navigator.serviceWorker.getRegistration('/');
        const sub = reg && await reg.pushManager.getSubscription();
        return sub && Notification.permission === 'granted' ? 'on' : 'off';
      } catch (e) { return 'off'; }
    },
    async enable() {
      if (!API.push.supported()) return ios ? 'install' : 'unsupported';
      const perm = await Notification.requestPermission();            // must run straight from the tap
      if (perm !== 'granted') return 'denied';
      try {
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        await navigator.serviceWorker.ready;
        const k = await API.call('GET', 'pushkey'); if (!k.ok) return 'error';
        const old = await reg.pushManager.getSubscription(); if (old) await old.unsubscribe();
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(k.data.key) });
        const r = await API.call('POST', 'push', { endpoint: sub.endpoint });
        if (!r.ok) { await sub.unsubscribe(); return 'error'; }
        return 'on';
      } catch (e) { return 'error'; }
    },
    async disable() {
      await API.call('POST', 'unpush', {});
      try { const reg = await navigator.serviceWorker.getRegistration('/'); const sub = reg && await reg.pushManager.getSubscription(); if (sub) await sub.unsubscribe(); } catch (e) {}
      return 'off';
    }
  };
  API.ready = API.health().then(j => (API.live = !!(j && j.ok)));
  window.GOHAESO_API = API;
})();
