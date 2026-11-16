// Realtime courtyard client. Speaks to /ws/<room> on the same origin.
// It offers the page the small "room" interface it already uses: peers(), onPeers(), presence(), join(), leave().
// Only presence fields travel (position, queue time, topic key, look indexes, duty flag). Never text.
(() => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const NAME = /^[a-z0-9][a-z0-9_.-]{0,47}$/;

  function open(name) {
    const peers = new Map(), subs = new Set(), mine = {};
    let me = null, ws = null, closed = false, retry = 0, sendT = 0, fireT = 0;

    const mk = (id, p, self) => ({ peer: id, by: null, isMe: self, sameTab: self, kind: 'viewer', guest: false, presence: p || {}, updatedAt: Date.now() });
    const fire = () => {
      if (fireT) return;
      fireT = setTimeout(() => {
        fireT = 0;
        const arr = [...peers.values()];
        subs.forEach(f => { try { f({ peers: arr, joined: [], left: [], updated: [] }); } catch (e) {} });
      }, 16);
    };
    const send = () => { if (ws && ws.readyState === 1 && me) ws.send(JSON.stringify({ t: 'p', p: mine })); };
    const queueSend = () => { if (!sendT) sendT = setTimeout(() => { sendT = 0; send(); }, 60); };

    function connect() {
      if (closed) return;
      ws = new WebSocket(`${proto}//${location.host}/ws/${name}`);
      ws.onmessage = e => {
        let m; try { m = JSON.parse(e.data); } catch (err) { return; }
        if (!m || typeof m !== 'object') return;
        if (m.t === 'hi' && typeof m.id === 'string') {
          me = m.id; retry = 0; peers.clear();
          peers.set(me, mk(me, { ...mine }, true));
          if (Array.isArray(m.peers)) for (const row of m.peers) if (Array.isArray(row) && typeof row[0] === 'string') peers.set(row[0], mk(row[0], row[1], false));
          if (Object.keys(mine).length) send();
        } else if (m.t === 'u' && typeof m.id === 'string') {
          if (m.id !== me) peers.set(m.id, mk(m.id, m.p, false));
        } else if (m.t === 'l' && typeof m.id === 'string') {
          peers.delete(m.id);
        } else return;
        fire();
      };
      ws.onclose = () => {
        if (closed) return;
        for (const k of [...peers.keys()]) if (k !== me) peers.delete(k);
        fire();
        setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
      };
      ws.onerror = () => {};
    }
    connect();

    return {
      name,
      peers: () => [...peers.values()],
      onPeers(fn) { subs.add(fn); fire(); return () => subs.delete(fn); },
      presence(patch) {
        for (const k of Object.keys(patch || {})) { if (patch[k] === null) delete mine[k]; else mine[k] = patch[k]; }
        if (me) peers.set(me, mk(me, { ...mine }, true));
        queueSend(); fire();
        return Promise.resolve();
      },
      leave() { closed = true; subs.clear(); try { ws.close(); } catch (e) {} return Promise.resolve(); },
      connected: () => !!ws && ws.readyState === 1
    };
  }

  const lobby = open('lobby');
  lobby.join = name => NAME.test(name) ? Promise.resolve(open(name)) : Promise.reject(new Error('invalid room name'));
  window.claude = { use: name => Promise.resolve(name === 'room' ? lobby : null) };
})();
