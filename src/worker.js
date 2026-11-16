// 작은 고해소 — realtime courtyard server.
// One Durable Object per room ("lobby", "yard-1" … "yard-99").
// It relays presence only: position, queue time, topic key, look indexes, duty flag.
// Free text is never accepted: every field is whitelisted and typed below, and nothing is logged or stored.
import { DurableObject } from 'cloudflare:workers';

const MAX_PEERS = 300;        // sockets per room
const MAX_BYTES = 600;        // one presence message
const MAX_PER_SEC = 20;       // messages per socket per second
const ST = new Set(['walk', 'queue', 'inside']);
const TP = new Set(['rel', 'fam', 'work', 'self', 'ai', 'etc']);

function clean(o) {
  const out = {};
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined);
  const int = (v, lo, hi) => { const n = num(v, lo, hi); return n === undefined ? undefined : Math.trunc(n); };
  const set = (k, v) => { if (v !== undefined) out[k] = v; };
  if (o.v === 1) out.v = 1;
  const x = num(o.x, -18, 18), z = num(o.z, -3.2, 18);
  set('x', x === undefined ? undefined : Math.round(x * 100) / 100);
  set('z', z === undefined ? undefined : Math.round(z * 100) / 100);
  set('qAt', int(o.qAt, 0, 1e15));
  set('fur', int(o.fur, 0, 15));
  set('nm', int(o.nm, 0, 31));
  set('yard', int(o.yard, 0, 99));
  if (ST.has(o.st)) out.st = o.st;
  if (TP.has(o.tp)) out.tp = o.tp;
  if (typeof o.duty === 'boolean') out.duty = o.duty;
  return out;
}

export class Room extends DurableObject {
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (this.ctx.getWebSockets().length >= MAX_PEERS) return new Response('room full', { status: 503 });

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);   // random per connection, not tied to a person
    const peers = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a) peers.push([a.id, a.p]);
    }
    this.ctx.acceptWebSocket(server);                                 // hibernation API: no cost while idle
    server.serializeAttachment({ id, p: {}, n: 0, w: Date.now() });
    server.send(JSON.stringify({ t: 'hi', id, peers }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > MAX_BYTES) return;
    const a = ws.deserializeAttachment();
    if (!a) return;
    const now = Date.now();
    if (now - a.w > 1000) { a.w = now; a.n = 0; }
    if (++a.n > MAX_PER_SEC) { ws.serializeAttachment(a); return; }
    let m;
    try { m = JSON.parse(message); } catch { return; }
    if (!m || m.t !== 'p') return;
    a.p = clean(m.p);
    ws.serializeAttachment(a);
    this.broadcast({ t: 'u', id: a.id, p: a.p }, ws);
  }

  webSocketClose(ws) { this.bye(ws); }
  webSocketError(ws) { this.bye(ws); }

  bye(ws) {
    const a = ws.deserializeAttachment();
    try { ws.close(1000, 'bye'); } catch {}
    if (a) this.broadcast({ t: 'l', id: a.id }, ws);
  }

  broadcast(m, except) {
    const s = JSON.stringify(m);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(s); } catch {}
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/ws\/(lobby|yard-[1-9][0-9]?)$/);
    if (m) {
      // Same-origin only: other sites cannot open sockets into the courtyard.
      const origin = request.headers.get('Origin');
      let ok = false;
      try { ok = !!origin && new URL(origin).host === url.host; } catch {}
      if (!ok) return new Response('forbidden', { status: 403 });
      return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(request);
    }
    if (url.pathname.startsWith('/ws/')) return new Response('not found', { status: 404 });
    return env.ASSETS.fetch(request);
  }
};
