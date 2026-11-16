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

export { Mailroom } from './mailroom.js';

// ---- mailbox API: /api/* -> the single Mailroom object ----
const ROUTES = {
  'GET /api/health': ['health', 0, false],
  'GET /api/me': ['me', 0, true],
  'POST /api/duty': ['duty', 1024, true],
  'POST /api/confess': ['confess', 8192, true],
  'POST /api/claim': ['claim', 1024, true],
  'POST /api/start': ['start', 1024, true],
  'POST /api/pass': ['pass', 1024, true],
  'POST /api/reply': ['reply', 131072, true],
  'GET /api/letter': ['letter', 0, true],
  'POST /api/thanks': ['thanks', 2048, true],
  'POST /api/warm': ['warm', 1024, true],
  'POST /api/report': ['report', 1024, true],
  'POST /api/block': ['block', 1024, true],
  'POST /api/forget': ['forget', 1024, true],
  'GET /api/pushkey': ['pushkey', 0, true],
  'POST /api/push': ['push', 2048, true],
  'POST /api/unpush': ['unpush', 1024, true],
  'GET /api/admin/reports': ['admin_reports', 0, true],
  'POST /api/admin/resolve': ['admin_resolve', 1024, true]
};
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
// The health check is shown as plain text so a phone browser displays it instead of downloading it.
const plain = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

async function api(request, env, url) {
  const route = ROUTES[`${request.method} ${url.pathname}`];
  if (!route) return reply(url.pathname.startsWith('/api/') && Object.keys(ROUTES).some(k => k.endsWith(' ' + url.pathname)) ? 405 : 404, { error: 'not_found' });
  const [name, maxBytes, auth] = route;
  // Same-origin only. A POST must carry an Origin that matches this site.
  const origin = request.headers.get('Origin');
  let sameOrigin = false;
  try { sameOrigin = !!origin && new URL(origin).host === url.host; } catch {}
  if (origin ? !sameOrigin : request.method !== 'GET') return reply(403, { error: 'forbidden' });

  let key = null;
  if (auth) {
    const m = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(request.headers.get('Authorization') || '');
    if (!m) return reply(401, { error: 'no_key' });
    key = m[1];
  }
  let body = {};
  if (request.method === 'POST') {
    if (!/^application\/json\b/i.test(request.headers.get('Content-Type') || '')) return reply(415, { error: 'json_only' });
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > maxBytes) return reply(413, { error: 'too_big' });
    const raw = await request.text();
    if (raw.length > maxBytes) return reply(413, { error: 'too_big' });
    try { body = JSON.parse(raw); } catch { return reply(400, { error: 'bad_json' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'bad_json' });
  }
  body._origin = url.origin;            // set here, never taken from the visitor
  try {
    const out = await env.MAILROOM.get(env.MAILROOM.idFromName('main')).op(name, key, request.headers.get('CF-Connecting-IP') || '', body);
    return name === 'health' ? plain(out.d) : reply(out.s, out.d);
  } catch {
    return reply(500, { error: 'server' });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Old *.workers.dev address -> the real domain (keys, notifications and the installed app live per address)
    const canon = env.CANONICAL_HOST;
    if (canon && url.host !== canon && url.hostname.endsWith('.workers.dev')) {
      return Response.redirect(`https://${canon}${url.pathname}${url.search}`, request.method === 'GET' || request.method === 'HEAD' ? 301 : 308);
    }
    if (url.pathname.startsWith('/api/')) return api(request, env, url);
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
