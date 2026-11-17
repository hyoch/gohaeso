import { webcrypto as crypto } from 'node:crypto';
const BASE = 'http://127.0.0.1:8788', ORIGIN = BASE;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const newKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
let fails = 0;
const ok = (n, c, extra) => { if (!c) fails++; console.log(c ? 'PASS' : 'FAIL', n, c ? '' : JSON.stringify(extra ?? '')); };
async function call(method, path, key, body, hdr = {}) {
  const h = { origin: ORIGIN, ...hdr };
  if (key) h.authorization = 'Bearer ' + key;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(BASE + '/api/' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let d = null; try { d = await r.json(); } catch {}
  return { s: r.status, d };
}
// a believable typing history of `text`: one keystroke at a time, 90–200 ms apart, one fix in the middle
function trace(text, step = 90) {
  const log = []; let t = 0, cur = '';
  for (const ch of [...text]) {
    t += step + Math.floor(Math.random() * 100);
    log.push([t, cur.length, 0, ch, 0]); cur += ch;
    if (cur.length === 8) { t += 2600; log.push([t, cur.length - 1, 1, '', 0]); cur = cur.slice(0, -1); t += 150; log.push([t, cur.length, 0, text[7], 0]); cur += text[7]; }
  }
  return log;
}
const REPLY = '그 무게를 혼자 들고 있었군요. 말해줘서 고마워요. 오늘은 조금만 덜 무거우면 그걸로 충분해요.';
const A = newKey(), B = newKey(), C = newKey(), D = newKey();

// ---- gates
ok('no key -> 401', (await call('GET', 'me')).s === 401);
ok('cross-origin POST -> 403', (await call('POST', 'duty', B, { on: true }, { origin: 'https://evil.example' })).s === 403);
ok('POST without Origin -> 403', (await call('POST', 'duty', B, { on: true }, { origin: '' })).s === 403);
{ const r = await fetch(BASE + '/api/duty', { method: 'POST', headers: { origin: ORIGIN, authorization: 'Bearer ' + B, 'content-type': 'text/plain' }, body: '{}' }); ok('non-JSON -> 415', r.status === 415); }
{ const r = await fetch(BASE + '/api/confess', { method: 'POST', headers: { origin: ORIGIN, authorization: 'Bearer ' + A, 'content-type': 'application/json' }, body: JSON.stringify({ topic: 'rel', text: 'x'.repeat(9000) }) }); ok('oversize body -> 413', r.status === 413); }
ok('bad key shape -> 401', (await call('GET', 'me', 'short')).s === 401);
ok('unknown route -> 404', (await call('GET', 'nope', A)).s === 404);

// ---- confess
ok('crisis text refused, not stored', (await call('POST', 'confess', A, { topic: 'self', text: '요즘 죽고 싶어요' })).d?.error === 'crisis');
ok('phone number refused', (await call('POST', 'confess', A, { topic: 'self', text: '전화 010-1234-5678 로 연락줘' })).d?.error === 'contact');
ok('bad topic refused', (await call('POST', 'confess', A, { topic: 'zzz', text: '안녕' })).d?.error === 'bad_topic');
ok('crisis attempt left nothing behind', (await call('GET', 'me', A)).d.mine === null);
const SECRET = '친구 생일에 AI가 쓴 축하를 보냈는데 그게 더 미안해요 ' + crypto.randomUUID().replace(/[0-9-]/g, '');
const c1 = await call('POST', 'confess', A, { topic: 'ai', text: SECRET });
ok('confess ok', c1.s === 200 && c1.d.waiting >= 1, c1);
ok('confess returns honest counts', c1.d.today === 1 && c1.d.total === 1, c1.d);
ok('second active confession refused', (await call('POST', 'confess', A, { topic: 'ai', text: '또' })).d?.error === 'active');
ok('me shows waiting', (await call('GET', 'me', A)).d.mine?.state === 'waiting');

// ---- duty + matching
ok('duty on', (await call('POST', 'duty', B, { on: true })).d.count >= 1);
ok('own confession is not offered to its author', (await call('POST', 'claim', A, {})).d.held === null);
ok('topic filter respected', (await call('POST', 'claim', B, { topics: ['fam'] })).d.held === null);
const cl = await call('POST', 'claim', B, { topics: ['ai', 'rel'] });
ok('B is assigned the confession with its text', cl.d.held?.text === SECRET && cl.d.held.state === 'assigned', cl);
const id = cl.d.held.id;
ok('claim again returns the same one', (await call('POST', 'claim', B, {})).d.held?.id === id);
ok('C gets nothing (already assigned)', (await call('POST', 'claim', C, {})).d.held === null);
ok('A sees it assigned, no text leaked', (await call('GET', 'me', A)).d.mine?.state === 'assigned');

// ---- reply rules
const tr = trace(REPLY);
ok('reply before start refused', (await call('POST', 'reply', B, { id, text: REPLY, log: tr })).d?.error === 'not_started');
ok('start reading', (await call('POST', 'start', B, { id })).d.deadline > Date.now());
ok('C cannot start B\'s confession', (await call('POST', 'start', C, { id })).s === 409);
ok('pasted-looking trace refused', (await call('POST', 'reply', B, { id, text: REPLY, log: [[5000, 0, 0, REPLY.slice(0, 13), 0]] })).d?.error === 'trace');
ok('one-shot paste refused even if split in two', (await call('POST', 'reply', B, { id, text: REPLY, log: [[3000, 0, 0, REPLY.slice(0, 12), 0], [6000, 12, 0, REPLY.slice(12, 24), 0], [9000, 24, 0, REPLY.slice(24), 0]] })).d?.error === 'trace');
ok('trace that does not rebuild the text refused', (await call('POST', 'reply', B, { id, text: REPLY + '!', log: tr })).d?.error === 'trace');
ok('typed-too-fast trace refused', (await call('POST', 'reply', B, { id, text: REPLY, log: trace(REPLY, 1).map(e => [Math.floor(e[0] / 90), ...e.slice(1)]) })).d?.error === 'trace');
ok('contact info in reply refused', (await call('POST', 'reply', B, { id, text: '카톡으로 이야기해요 ' + REPLY, log: trace('카톡으로 이야기해요 ' + REPLY) })).d?.error === 'contact');
ok('too short reply refused', (await call('POST', 'reply', B, { id, text: '힘내요', log: trace('힘내요') })).d?.error === 'bad_text');
ok('C cannot reply to it', (await call('POST', 'reply', C, { id, text: REPLY, log: tr })).s === 409);
const rp = await call('POST', 'reply', B, { id, text: REPLY, log: tr, blurs: 2 });
ok('valid reply accepted, stats computed by server', rp.s === 200 && rp.d.stats.fixes === 1 && rp.d.stats.len === REPLY.length, rp);

// ---- letter (MAIL_DELAY_MS=0 in dev)
const me = (await call('GET', 'me', A)).d;
ok('A sees answered + ready', me.mine?.state === 'answered' && me.mine.ready === true, me.mine);
ok('thanks refused before reading', (await call('POST', 'thanks', A, { text: '고마워요' })).d?.error === 'not_read');
const L = await call('GET', 'letter', A);
ok('letter decrypts to the exact reply', L.d.letter?.text === REPLY);
ok('letter carries a replayable trace', Array.isArray(L.d.letter.log) && L.d.letter.log.length === tr.length);
ok('letter stats include blurs', L.d.letter.stats.blurs === 2 && L.d.letter.stats.pauses >= 1, L.d.letter.stats);
ok('stranger has no letter', (await call('GET', 'letter', C)).d.letter === null);
ok('warm', (await call('POST', 'warm', A, {})).d.warm === true);
ok('thanks with link refused', (await call('POST', 'thanks', A, { text: 'https://x.com 고마워요' })).d?.error === 'contact');
ok('thanks ok', (await call('POST', 'thanks', A, { text: '덕분에 오늘은 덜 무거웠어요.' })).d.thanked === true);
ok('second thanks refused', (await call('POST', 'thanks', A, { text: '또 고마워요' })).d?.error === 'already');
const fb = (await call('GET', 'me', B)).d.feedback;
ok('priest sees candle and thanks', fb.warm === 1 && fb.thanks[0]?.text === '덕분에 오늘은 덜 무거웠어요.', fb);
ok('only author sees feedback', (await call('GET', 'me', C)).d.feedback.warm === 0);

// ---- report / block
const A2 = newKey(), B2 = newKey();
await call('POST', 'confess', A2, { topic: 'rel', text: '연인에게 작은 거짓말을 했어요' });
const cl2 = await call('POST', 'claim', B2, {});
ok('B2 gets A2\'s confession', cl2.d.held?.state === 'assigned');
ok('bad reason refused', (await call('POST', 'report', B2, { kind: 'conf', id: cl2.d.held.id, reason: 'zzz' })).s === 400);
ok('report with a care reason', (await call('POST', 'report', B2, { kind: 'conf', id: cl2.d.held.id, reason: 'care' })).d.reported === true);
ok('care report closes it with a care notice for the confessor', (await call('GET', 'me', A2)).d.mine?.state === 'care');
ok('B2 holds nothing now', (await call('GET', 'me', B2)).d.held === null);
// block: priest passes on a confession and never sees that author again
const A3 = newKey();
await call('POST', 'confess', A3, { topic: 'work', text: '회사에서 제 실수를 동료 탓으로 돌렸어요' });
const cl3 = await call('POST', 'claim', B2, {});
ok('B2 gets A3', cl3.d.held?.state === 'assigned');
ok('block returns it to the queue', (await call('POST', 'block', B2, { kind: 'conf', id: cl3.d.held.id })).d.blocked === true);
ok('B2 never offered A3 again', (await call('POST', 'claim', B2, {})).d.held === null);
ok('another priest still can', (await call('POST', 'claim', D, {})).d.held?.state === 'assigned');
// pass limit (2/day)
await call('POST', 'pass', D, { id: (await call('GET', 'me', D)).d.held.id });
const A4 = newKey(), A5 = newKey(), A6 = newKey();
for (const [k, t] of [[A4, 'self'], [A5, 'self'], [A6, 'self']]) await call('POST', 'confess', k, { topic: t, text: '나 자신이 싫은 날이 있어요 ' + t });
let passes = 1, lastErr = null;
for (let i = 0; i < 3; i++) {
  const h = (await call('POST', 'claim', D, { topics: ['self'] })).d.held; if (!h) break;
  const r = await call('POST', 'pass', D, { id: h.id }); if (r.s === 200) passes++; else lastErr = r.d.error;
}
ok('third pass of the day refused', passes === 2 && lastErr === 'limit', { passes, lastErr });

// ---- reply to a reply: report as AI, hidden for the confessor, author restricted after 3 distinct reporters
const authorB = newKey();
async function replyThread(confessor, topic = 'etc') {
  await call('POST', 'confess', confessor, { topic, text: '키우던 강아지가 아플 때 늦게 데려갔어요 ' + crypto.randomUUID().replace(/[0-9-]/g, '') });
  const h = (await call('POST', 'claim', authorB, { topics: [topic] })).d.held; if (!h) return null;
  await call('POST', 'start', authorB, { id: h.id });
  const t = REPLY + ' ' + crypto.randomUUID().replace(/[0-9-]/g, '').slice(0, 4);
  return (await call('POST', 'reply', authorB, { id: h.id, text: t, log: trace(t) })).s;
}
const rep = [newKey(), newKey(), newKey()];
const sts = []; for (const k of rep) sts.push(await replyThread(k));
ok('author replied to 3 threads (daily limit 3)', sts.every(s => s === 200), sts);
for (const k of rep) ok('report reply as AI', (await call('POST', 'report', k, { kind: 'reply', reason: 'ai' })).d.reported === true);
ok('reported reply is hidden from the confessor', (await call('GET', 'letter', rep[0])).d.letter === null);
ok('author with 3 reports is restricted', (await call('POST', 'claim', authorB, {})).d?.error === 'restricted' || (await call('POST', 'claim', authorB, {})).s === 403);

// ---- operator
const ADMIN = process.env.ADMIN_TOKEN;
ok('admin without token refused', (await call('GET', 'admin/reports', 'x'.repeat(30))).s === 401);
if (ADMIN) {
  const ar = await call('GET', 'admin/reports', ADMIN);
  ok('operator reads only reported items', ar.s === 200 && ar.d.reports.length >= 4 && ar.d.reports.every(r => !('owner' in r) && !('by' in r)), ar.d);
  ok('operator sees reported reply text + stats', ar.d.reports.some(r => r.kind === 'reply' && r.reason === 'ai' && r.text && r.stats));
  ok('operator cannot see care-report text', ar.d.reports.filter(r => r.reason === 'care').every(r => !r.text));
}

// ---- timeouts: assignment expires and moves on
const E1 = newKey(), E2 = newKey(), E3 = newKey();
await call('POST', 'confess', E1, { topic: 'fam', text: '엄마 전화를 일주일째 안 받고 있어요' });
const e2 = (await call('POST', 'claim', E2, { topics: ['fam'] })).d.held;
ok('E2 assigned', !!e2);
await sleep(4600);
ok('assignment released after the start window', (await call('GET', 'me', E2)).d.held === null);
ok('same priest is not offered it again', (await call('POST', 'claim', E2, { topics: ['fam'] })).d.held === null);
const e3 = (await call('POST', 'claim', E3, { topics: ['fam'] })).d.held;
ok('next priest gets it', e3?.id === e2.id);
await call('POST', 'start', E3, { id: e3.id });
await sleep(8600);
ok('reply window enforced (reading too long)', (await call('POST', 'reply', E3, { id: e3.id, text: REPLY, log: trace(REPLY) })).d?.error === 'lost');
// 48h expiry (30s in dev)
await sleep(18000);
const exp = (await call('GET', 'me', E1)).d.mine;
ok('unanswered confession expires and the confessor is told', exp?.state === 'expired', exp);
ok('expired text is gone, new confession allowed next day only', (await call('POST', 'confess', E1, { topic: 'fam', text: '다시' })).d?.error === 'today_done');
// duty heartbeat expiry
await sleep(5200);
ok('duty lapses without heartbeat', (await call('GET', 'me', B)).d.duty.on === false);

// ---- forget
const F = newKey();
await call('POST', 'confess', F, { topic: 'etc', text: '지울 고해' });
ok('forget', (await call('POST', 'forget', F, {})).d.forgotten === true);
ok('forgotten: nothing left', (await call('GET', 'me', F)).d.mine === null);
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
