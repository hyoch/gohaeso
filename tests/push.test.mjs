import { webcrypto as crypto } from 'node:crypto';
import http from 'node:http';
const BASE = 'http://127.0.0.1:8788', SINK = '127.0.0.1:9911';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const newKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
let fails = 0; const ok = (n, c, x) => { if (!c) fails++; console.log(c ? 'PASS' : 'FAIL', n, c ? '' : JSON.stringify(x ?? '')); };
async function call(method, path, key, body) {
  const h = { origin: BASE }; if (key) h.authorization = 'Bearer ' + key; if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(BASE + '/api/' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let d = null; try { d = await r.json(); } catch {} return { s: r.status, d };
}
function trace(text) { const log = []; let t = 0, cur = ''; for (const ch of [...text]) { t += 90 + Math.floor(Math.random() * 100); log.push([t, cur.length, 0, ch, 0]); cur += ch;
  if (cur.length === 8) { t += 2600; log.push([t, cur.length - 1, 1, '', 0]); cur = cur.slice(0, -1); t += 150; log.push([t, cur.length, 0, text[7], 0]); cur += text[7]; } } return log; }
const REPLY = '그 무게를 혼자 들고 있었군요. 말해줘서 고마워요. 오늘은 조금만 덜 무거우면 그걸로 충분해요.';
const got = [];
const srv = http.createServer((q, r) => { got.push({ url: q.url, auth: q.headers.authorization, ttl: q.headers.ttl, len: q.headers['content-length'] }); q.resume(); r.statusCode = 201; r.end(); }).listen(9911);
const A = newKey(), B = newKey();
// bad endpoints refused (SSRF guard)
for (const e of ['http://169.254.169.254/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://user:pw@fcm.googleapis.com/x', 'file:///etc/passwd', 'x'.repeat(700)])
  ok('bad endpoint refused: ' + e.slice(0, 40), (await call('POST', 'push', A, { endpoint: e })).d?.error === 'bad_endpoint');
ok('good push host accepted', (await call('POST', 'push', newKey(), { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' })).s === 200);
const pk = await call('GET', 'pushkey', A); ok('pushkey returned (65-byte point)', Buffer.from(pk.d.key, 'base64url').length === 65, pk);
const pk2 = await call('GET', 'pushkey', B); ok('same key for everyone', pk2.d.key === pk.d.key);
ok('push without key -> 401', (await call('POST', 'push', undefined, { endpoint: 'x' })).s === 401);
// flow
await call('POST', 'confess', A, { topic: 'rel', text: '푸시 알림 시험용 고해예요 ' + crypto.randomUUID().replace(/[0-9-]/g, '') });
ok('A subscribes (dev sink)', (await call('POST', 'push', A, { endpoint: 'http://' + SINK + '/sub/abc' })).s === 200);
await call('POST', 'duty', B, { on: true });
const cl = await call('POST', 'claim', B, { topics: ['rel'] }); const id = cl.d.held.id;
await call('POST', 'start', B, { id });
const rp = await call('POST', 'reply', B, { id, text: REPLY, log: trace(REPLY) });
ok('reply accepted', rp.s === 200, rp);
await sleep(4000);
ok('push sent once when the letter was due', got.length === 1, got);
const g = got[0] || {};
ok('request is empty-bodied with vapid header + TTL', /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/.test(g.auth || '') && g.ttl === '86400' && (g.len === undefined || g.len === '0'), g);
// verify ES256 signature with the public key
{
  const mm = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(g.auth); const [, h, b, s, kk] = mm;
  ok('header k equals /api/pushkey', kk === pk.d.key, { kk, key: pk.d.key });
  const pub = await crypto.subtle.importKey('raw', Buffer.from(kk, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(s, 'base64url'), new TextEncoder().encode(h + '.' + b));
  const claims = JSON.parse(Buffer.from(b, 'base64url').toString());
  ok('JWT signature verifies against the public key', valid);
  ok('JWT claims: aud is the push origin, exp within 24h, sub is https', claims.aud === 'http://' + SINK && claims.exp - Date.now() / 1000 < 86400 && claims.exp > Date.now() / 1000 && /^http/.test(claims.sub), claims);
}
await sleep(1500);
ok('not sent twice', got.length === 1, got.length);
// unsubscribe
ok('A unsubscribes', (await call('POST', 'unpush', A, {})).s === 200);
// second letter with no subscription -> nothing sent
const A2 = newKey(), B2 = newKey();
await call('POST', 'confess', A2, { topic: 'rel', text: '두 번째 시험 ' + crypto.randomUUID().replace(/[0-9-]/g, '') });
await call('POST', 'duty', B2, { on: true }); const c2 = await call('POST', 'claim', B2, { topics: ['rel'] });
await call('POST', 'start', B2, { id: c2.d.held.id }); await call('POST', 'reply', B2, { id: c2.d.held.id, text: REPLY, log: trace(REPLY) });
await sleep(3500);
ok('no push for someone who did not ask', got.length === 1, got.length);
// forget removes subscription
const A3 = newKey(); await call('POST', 'push', A3, { endpoint: 'http://' + SINK + '/sub/zzz' });
await call('POST', 'forget', A3, {});
srv.close(); console.log(fails ? `\n${fails} FAILED` : '\nPUSH TESTS PASSED'); process.exit(fails ? 1 : 0);
