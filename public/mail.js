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
  API.ready = API.health().then(j => (API.live = !!(j && j.ok)));
  window.GOHAESO_API = API;
})();
