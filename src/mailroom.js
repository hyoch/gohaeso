// 작은 고해소 — the mailroom.
// One Durable Object (SQLite) is the only place confessions, replies and thank-yous live, and it is the only writer,
// so matching (who gets which confession) is atomic. Everything is sealed with AES-GCM (see vault.js); no key, no network
// address and no plain text is ever stored. Deadlines and deletions are enforced here, never by the browser.
import { DurableObject } from 'cloudflare:workers';
import { Vault } from './vault.js';
import { LIM, TOPICS, REASONS, CRISIS, CONTACT_STRICT, CONTACT_ANY, kstDay, nextDeliver, checkTrace } from './rules.js';

const err = (s, e) => ({ s, d: { error: e } });
const ok = d => ({ s: 200, d });
const rid = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
const OPEN = "('waiting','assigned','reading')";
const OPS = new Set(['me', 'duty', 'confess', 'claim', 'start', 'pass', 'reply', 'letter', 'thanks', 'warm', 'report', 'block', 'forget', 'pushkey', 'push', 'unpush']);

// Web Push (letter-arrived notifications). Only these push services are ever contacted, so a visitor cannot make the server call any other address.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
const b64u = buf => { let s = ''; new Uint8Array(buf).forEach(x => { s += String.fromCharCode(x); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const b64uStr = str => b64u(new TextEncoder().encode(str));

function safeEq(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

export class Mailroom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.vault = new Vault(env.MASTER_KEY);
    this.hits = new Map();      // rate limiting lives in memory only
    this.L = { ...LIM };        // limits; DEV_LIMITS (JSON, for local tests only) may shorten them
    try { if (env.DEV_LIMITS) Object.assign(this.L, JSON.parse(env.DEV_LIMITS)); } catch {}
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  migrate() {
    const s = q => this.sql.exec(q);
    s(`CREATE TABLE IF NOT EXISTS conf(id TEXT PRIMARY KEY, owner TEXT NOT NULL, topic TEXT NOT NULL, ct BLOB, iv BLOB,
       created INTEGER NOT NULL, state TEXT NOT NULL, holder TEXT, assigned INTEGER, started INTEGER, ended INTEGER)`);
    s('CREATE INDEX IF NOT EXISTS conf_state ON conf(state, created)');
    s('CREATE INDEX IF NOT EXISTS conf_owner ON conf(owner, created)');
    s('CREATE INDEX IF NOT EXISTS conf_holder ON conf(holder)');
    s(`CREATE TABLE IF NOT EXISTS reply(conf_id TEXT PRIMARY KEY, ct BLOB NOT NULL, iv BLOB NOT NULL, tct BLOB NOT NULL, tiv BLOB NOT NULL,
       stats TEXT NOT NULL, created INTEGER NOT NULL, deliver INTEGER NOT NULL, read_at INTEGER, warm INTEGER NOT NULL DEFAULT 0,
       hidden INTEGER NOT NULL DEFAULT 0, author TEXT NOT NULL)`);
    s('CREATE INDEX IF NOT EXISTS reply_author ON reply(author)');
    s('CREATE TABLE IF NOT EXISTS thanks(conf_id TEXT PRIMARY KEY, ct BLOB NOT NULL, iv BLOB NOT NULL, created INTEGER NOT NULL)');
    s('CREATE TABLE IF NOT EXISTS passed(conf_id TEXT NOT NULL, who TEXT NOT NULL, PRIMARY KEY(conf_id, who))');
    s('CREATE TABLE IF NOT EXISTS block(who TEXT NOT NULL, other TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(who, other))');
    s('CREATE TABLE IF NOT EXISTS duty(who TEXT PRIMARY KEY, seen INTEGER NOT NULL)');
    s('CREATE TABLE IF NOT EXISTS usage(who TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(who, day, kind))');
    s('CREATE TABLE IF NOT EXISTS push(who TEXT PRIMARY KEY, ct BLOB NOT NULL, iv BLOB NOT NULL, created INTEGER NOT NULL)');
    s('CREATE TABLE IF NOT EXISTS vapid(id INTEGER PRIMARY KEY CHECK(id=1), pub TEXT NOT NULL, ct BLOB NOT NULL, iv BLOB NOT NULL)');
    s('CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    // daily totals for the operator: a date, a kind of event and a count. Nothing that points to anyone.
    s('CREATE TABLE IF NOT EXISTS daily(day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(day, kind))');
    try { s('ALTER TABLE reply ADD COLUMN notified INTEGER NOT NULL DEFAULT 0'); } catch {}
    s(`CREATE TABLE IF NOT EXISTS report(id TEXT PRIMARY KEY, kind TEXT NOT NULL, conf_id TEXT NOT NULL, target TEXT NOT NULL,
       reason TEXT NOT NULL, by TEXT NOT NULL, created INTEGER NOT NULL)`);
  }

  q(sql, ...a) { return this.sql.exec(sql, ...a).toArray(); }
  run(sql, ...a) { this.sql.exec(sql, ...a).toArray(); }
  hit(k, max) {
    const t = Date.now();
    if (this.hits.size > 5000) for (const [key, v] of this.hits) if (t - v.s > 60e3) this.hits.delete(key);
    let a = this.hits.get(k);
    if (!a || t - a.s > 60e3) { a = { s: t, n: 0 }; this.hits.set(k, a); }
    return ++a.n <= max;
  }
  used(who, kind, day) { const r = this.q('SELECT n FROM usage WHERE who=? AND day=? AND kind=?', who, day, kind)[0]; return r ? r.n : 0; }
  bump(who, kind, day) { this.run('INSERT INTO usage(who,day,kind,n) VALUES(?,?,?,1) ON CONFLICT(who,day,kind) DO UPDATE SET n=n+1', who, day, kind); }
  tally(kind, n = 1, now = Date.now()) { if (n > 0) this.run('INSERT INTO daily(day,kind,n) VALUES(?,?,?) ON CONFLICT(day,kind) DO UPDATE SET n=n+?', kstDay(now), kind, n, n); }
  dutyCount(now) { return this.q('SELECT COUNT(*) c FROM duty WHERE seen>?', now - this.L.DUTY_TTL_MS)[0].c; }
  restricted(who, now) {
    return this.q("SELECT COUNT(DISTINCT by) c FROM report WHERE target=? AND kind='reply' AND created>?", who, now - this.L.REPORT_KEEP_MS)[0].c >= this.L.RESTRICT_REPORTS;
  }

  /* ---------- entry point (called by the Worker) ---------- */
  async op(name, key, ip, body) {
    try {
      if (name === 'health') return ok({ ok: Vault.valid(this.env.MASTER_KEY), duty: this.dutyCount(Date.now()) });
      if (!Vault.valid(this.env.MASTER_KEY)) return err(503, 'not_configured');
      const now = Date.now();
      if (name === 'admin_reports' || name === 'admin_resolve' || name === 'admin_stats') return await this.admin(name, key, body || {}, now);
      if (!OPS.has(name)) return err(404, 'unknown');
      if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key)) return err(401, 'no_key');
      const [ipTag, who] = await Promise.all([this.vault.tag('ip', ip || ''), this.vault.tag('who', key)]);
      if (!this.hit('ip:' + ipTag, 300) || !this.hit('who:' + who, 120)) return err(429, 'slow_down');
      this.sweep(now);
      const out = await this['do_' + name](who, body && typeof body === 'object' ? body : {}, now);
      await this.arm();
      return out;
    } catch (e) {
      return err(500, 'server');      // nothing about the request is logged
    }
  }

  /* ---------- housekeeping: deadlines and deletion ---------- */
  sweep(now) {
    const day = kstDay(now);
    // assignments that ran out of time go back to the queue, and that priest is not offered the same one again
    for (const r of this.q(`SELECT id, holder FROM conf WHERE (state='assigned' AND assigned<?) OR (state='reading' AND started<?)`, now - this.L.START_MS, now - this.L.REPLY_MS)) {
      this.run('INSERT OR IGNORE INTO passed(conf_id, who) VALUES(?,?)', r.id, r.holder);
      this.run(`UPDATE conf SET state='waiting', holder=NULL, assigned=NULL, started=NULL WHERE id=?`, r.id);
    }
    // nobody answered in 48 hours: the text is erased, a notice remains so the confessor is told honestly
    this.tally('expired', this.q(`SELECT COUNT(*) c FROM conf WHERE state IN ${OPEN} AND created<?`, now - this.L.WAIT_MS)[0].c, now);
    this.run(`UPDATE conf SET state='expired', ct=x'', iv=x'', holder=NULL, ended=? WHERE state IN ${OPEN} AND created<?`, now, now - this.L.WAIT_MS);
    this.run(`DELETE FROM conf WHERE state IN ('expired','care') AND ended<?`, now - this.L.TOMB_MS);
    this.run(`DELETE FROM conf WHERE state='reported' AND ended<?`, now - this.L.REPORT_KEEP_MS);
    // answered threads
    this.run(`DELETE FROM conf WHERE state='answered' AND id IN (SELECT conf_id FROM reply WHERE read_at IS NOT NULL AND read_at<?)`, now - this.L.READ_KEEP_MS);
    this.run(`DELETE FROM conf WHERE state='answered' AND id IN (SELECT conf_id FROM reply WHERE read_at IS NULL AND deliver<?)`, now - this.L.UNREAD_KEEP_MS);
    this.run(`DELETE FROM conf WHERE state='answered' AND id IN (SELECT conf_id FROM reply WHERE hidden=1 AND created<?)`, now - this.L.REPORT_KEEP_MS);
    this.run('DELETE FROM reply WHERE conf_id NOT IN (SELECT id FROM conf)');
    this.run('DELETE FROM thanks WHERE conf_id NOT IN (SELECT id FROM conf)');
    this.run('DELETE FROM passed WHERE conf_id NOT IN (SELECT id FROM conf)');
    this.run('DELETE FROM duty WHERE seen<?', now - this.L.DUTY_TTL_MS);
    // a notification address is kept only while a thread is open (plus a day of grace), then forgotten
    this.run(`DELETE FROM push WHERE created<? AND who NOT IN (SELECT owner FROM conf WHERE state IN ('waiting','assigned','reading','answered'))`, now - 864e5);
    this.run('DELETE FROM report WHERE created<?', now - this.L.REPORT_KEEP_MS);
    this.run('DELETE FROM block WHERE at<?', now - 60 * 864e5);
    this.run('DELETE FROM usage WHERE day<?', kstDay(now - 3 * 864e5));
    this.run('DELETE FROM daily WHERE day<?', kstDay(now - 90 * 864e5));
  }

  async arm() {
    const busy = this.q(`SELECT 1 FROM conf WHERE state IN ${OPEN} LIMIT 1`).length > 0;
    const any = busy || this.q('SELECT 1 FROM conf LIMIT 1').length > 0 || this.q('SELECT 1 FROM duty LIMIT 1').length > 0;
    if (!any) return;
    let want = Date.now() + (busy ? 5 * 60e3 : 3600e3);
    // wake up exactly when a letter is due for someone who asked to be notified
    const due = this.q(`SELECT MIN(r.deliver) d FROM reply r JOIN conf c ON c.id=r.conf_id JOIN push p ON p.who=c.owner
                        WHERE r.notified=0 AND r.hidden=0 AND c.state='answered'`)[0];
    if (due && due.d !== null) want = Math.min(want, Math.max(due.d, Date.now() + 1000));
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > want) await this.ctx.storage.setAlarm(want);
  }
  async alarm() {
    const now = Date.now();
    this.sweep(now);
    try { await this.notifyDue(now); } catch {}
    await this.arm();
  }

  /* ---------- letter-arrived notifications (Web Push, no payload) ---------- */
  // The push carries no text at all. The service worker shows a fixed line, so the push service learns nothing about the letter.
  async vapidKeys() {
    if (this._vapid) return this._vapid;
    const row = this.q('SELECT pub, ct, iv FROM vapid WHERE id=1')[0];
    if (row) {
      try {
        const jwk = JSON.parse(await this.vault.open(row.ct, row.iv, 'vapid'));
        const priv = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
        return (this._vapid = { pub: row.pub, priv });
      } catch { this.run('DELETE FROM vapid'); this.run('DELETE FROM push'); }   // MASTER_KEY changed: old keys and addresses are unreadable
    }
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pub = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const sealed = await this.vault.seal(JSON.stringify(jwk), 'vapid');
    this.run('INSERT OR REPLACE INTO vapid(id, pub, ct, iv) VALUES(1,?,?,?)', pub, sealed.ct, sealed.iv);
    const priv = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return (this._vapid = { pub, priv });
  }

  pushUrl(endpoint) {
    if (typeof endpoint !== 'string' || endpoint.length > 600) return null;
    let u; try { u = new URL(endpoint); } catch { return null; }
    const dev = this.L.PUSH_ALLOW_HOST;                                   // local tests only; never set in production
    if (dev && u.host === dev) return u;
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    return PUSH_HOSTS.some(re => re.test(u.hostname)) ? u : null;
  }

  async sendPush(url) {
    const { pub, priv } = await this.vapidKeys();
    const origin = (this.q(`SELECT v FROM kv WHERE k='origin'`)[0] || {}).v || 'https://example.invalid';
    const head = b64uStr(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const body = b64uStr(JSON.stringify({ aud: url.origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: origin }));
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, new TextEncoder().encode(head + '.' + body));
    const r = await fetch(url.toString(), {
      method: 'POST', signal: AbortSignal.timeout(6000),
      headers: { TTL: '86400', Urgency: 'normal', Authorization: `vapid t=${head}.${body}.${b64u(sig)}, k=${pub}` }
    });
    return r.status;
  }

  async notifyDue(now) {
    const rows = this.q(`SELECT r.conf_id id, c.owner who FROM reply r JOIN conf c ON c.id=r.conf_id
                         WHERE r.notified=0 AND r.hidden=0 AND r.deliver<=? AND c.state='answered' LIMIT 20`, now);
    for (const r of rows) {
      this.run('UPDATE reply SET notified=1 WHERE conf_id=?', r.id);          // at most once per letter
      const p = this.q('SELECT ct, iv FROM push WHERE who=?', r.who)[0];
      if (!p) continue;
      try {
        const url = this.pushUrl(await this.vault.open(p.ct, p.iv, 'push:' + r.who));
        if (!url) { this.run('DELETE FROM push WHERE who=?', r.who); continue; }
        const st = await this.sendPush(url);
        if (st === 404 || st === 410) this.run('DELETE FROM push WHERE who=?', r.who);   // the browser dropped the subscription
      } catch { /* the letter is still in the mailbox; the notification is only a convenience */ }
    }
  }

  /* ---------- views ---------- */
  heldRow(who, id) {
    const sql = `SELECT id, owner, topic, state, created, assigned, started, ct, iv FROM conf WHERE holder=? AND state IN ('assigned','reading')` + (id ? ' AND id=?' : '');
    return (id ? this.q(sql, who, id) : this.q(sql, who))[0] || null;
  }
  async heldView(who, now) {
    const h = this.heldRow(who);
    if (!h) return null;
    return {
      id: h.id, topic: h.topic, state: h.state, waited: now - h.created,
      deadline: h.state === 'assigned' ? h.assigned + this.L.START_MS : h.started + this.L.REPLY_MS,
      text: await this.vault.open(h.ct, h.iv, 'conf:' + h.id)
    };
  }

  /* ---------- operations ---------- */
  async do_me(who, b, now) {
    const day = kstDay(now);
    const row = this.q('SELECT * FROM conf WHERE owner=? ORDER BY created DESC LIMIT 1', who)[0];
    let mine = null;
    if (row) {
      if (row.state === 'waiting' || row.state === 'assigned' || row.state === 'reading') {
        mine = { state: row.state === 'waiting' ? 'waiting' : row.state === 'assigned' ? 'assigned' : 'reading', created: row.created, expiresAt: row.created + this.L.WAIT_MS };
      } else if (row.state === 'answered') {
        const r = this.q('SELECT deliver, read_at, warm, hidden, stats FROM reply WHERE conf_id=?', row.id)[0];
        if (!r || r.hidden) mine = { state: 'closed' };
        else mine = {
          state: 'answered', deliverAt: r.deliver, ready: r.deliver <= now, readAt: r.read_at || null, warm: !!r.warm,
          thanked: this.q('SELECT 1 FROM thanks WHERE conf_id=?', row.id).length > 0,
          deleteAt: r.read_at ? r.read_at + this.L.READ_KEEP_MS : r.deliver + this.L.UNREAD_KEEP_MS
        };
      } else mine = { state: row.state === 'reported' ? 'closed' : row.state, created: row.created };   // expired | care | closed
    }
    const held = await this.heldView(who, now);
    const thanks = [];
    for (const t of this.q('SELECT t.conf_id, t.ct, t.iv, t.created FROM thanks t JOIN reply r ON r.conf_id=t.conf_id WHERE r.author=? ORDER BY t.created DESC LIMIT 5', who)) {
      thanks.push({ at: t.created, text: await this.vault.open(t.ct, t.iv, 'thanks:' + t.conf_id) });
    }
    const replied = this.used(who, 'reply', day), passed = this.used(who, 'pass', day);
    return ok({
      now,
      duty: { count: this.dutyCount(now), on: this.q('SELECT 1 FROM duty WHERE who=? AND seen>?', who, now - this.L.DUTY_TTL_MS).length > 0 },
      queue: { waiting: this.q(`SELECT COUNT(*) c FROM conf WHERE state='waiting'`)[0].c, dayLeft: Math.max(0, this.L.DAY_CAP - this.used('*', 'conf', day)) },
      today: { repliesLeft: Math.max(0, this.L.REPLIES_PER_DAY - replied), passesLeft: Math.max(0, this.L.PASSES_PER_DAY - passed), canConfess: this.used(who, 'conf', day) < this.L.CONF_PER_DAY },
      windows: { startMs: this.L.START_MS, replyMs: this.L.REPLY_MS },
      mine, held,
      feedback: { warm: this.q('SELECT COALESCE(SUM(warm),0) w FROM reply WHERE author=?', who)[0].w, thanks }
    });
  }

  async do_pushkey(who, b, now) {
    this.rememberOrigin(b);
    return ok({ key: (await this.vapidKeys()).pub });
  }
  rememberOrigin(b) {
    if (typeof b._origin === 'string' && /^https:\/\/[a-z0-9.-]+$/i.test(b._origin) || (this.L.PUSH_ALLOW_HOST && typeof b._origin === 'string')) {
      this.run(`INSERT INTO kv(k, v) VALUES('origin', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, b._origin);
    }
  }
  async do_push(who, b, now) {
    const url = this.pushUrl(b.endpoint);
    if (!url) return err(400, 'bad_endpoint');
    this.rememberOrigin(b);
    await this.vapidKeys();
    const s = await this.vault.seal(url.toString(), 'push:' + who);
    this.run('INSERT INTO push(who, ct, iv, created) VALUES(?,?,?,?) ON CONFLICT(who) DO UPDATE SET ct=excluded.ct, iv=excluded.iv, created=excluded.created', who, s.ct, s.iv, now);
    return ok({ on: true });
  }
  async do_unpush(who, b, now) {
    this.run('DELETE FROM push WHERE who=?', who);
    return ok({ on: false });
  }

  async do_duty(who, b, now) {
    if (b.on === true) this.run('INSERT INTO duty(who, seen) VALUES(?,?) ON CONFLICT(who) DO UPDATE SET seen=excluded.seen', who, now);
    else this.run('DELETE FROM duty WHERE who=?', who);
    return ok({ on: b.on === true, count: this.dutyCount(now) });
  }

  async do_confess(who, b, now) {
    const text = typeof b.text === 'string' ? b.text.replace(/\r\n/g, '\n').trim() : '';
    if (!TOPICS.has(b.topic)) return err(400, 'bad_topic');
    if (!text || text.length > this.L.CONF_MAX) return err(400, 'bad_text');
    if (CRISIS.test(text)) return err(422, 'crisis');            // never stored, never forwarded: the page shows the help numbers
    if (CONTACT_STRICT.test(text)) return err(422, 'contact');
    const day = kstDay(now);
    const gate = () => {
      const cur = this.q(`SELECT state FROM conf WHERE owner=? AND state IN ('waiting','assigned','reading','answered') LIMIT 1`, who)[0];
      if (cur) return err(409, 'active');
      if (this.used(who, 'conf', day) >= this.L.CONF_PER_DAY) return err(429, 'today_done');
      if (this.used('*', 'conf', day) >= this.L.DAY_CAP) return err(429, 'day_full');
      return null;
    };
    let e = gate(); if (e) return e;
    const id = rid();
    const sealed = await this.vault.seal(text, 'conf:' + id);
    e = gate(); if (e) return e;                                   // state may have changed while sealing
    this.run(`DELETE FROM conf WHERE owner=? AND state IN ('expired','care')`, who);
    this.run('INSERT INTO conf(id, owner, topic, ct, iv, created, state) VALUES(?,?,?,?,?,?,?)', id, who, b.topic, sealed.ct, sealed.iv, now, 'waiting');
    this.bump(who, 'conf', day); this.bump('*', 'conf', day); this.tally('conf', 1, now);
    // an anonymous running count, shown back honestly: how many have left a heavy heart here (no link to any key)
    this.run(`INSERT INTO kv(k, v) VALUES('total_conf', '1') ON CONFLICT(k) DO UPDATE SET v=CAST(CAST(v AS INTEGER)+1 AS TEXT)`);
    const total = Number((this.q(`SELECT v FROM kv WHERE k='total_conf'`)[0] || {}).v) || 1;
    return ok({ today: this.used('*', 'conf', day), total, waiting: this.q(`SELECT COUNT(*) c FROM conf WHERE state='waiting'`)[0].c, duty: this.dutyCount(now), expiresAt: now + this.L.WAIT_MS });
  }

  async do_claim(who, b, now) {
    const day = kstDay(now);
    if (!this.heldRow(who)) {
      if (this.restricted(who, now)) return err(403, 'restricted');
      if (this.used(who, 'reply', day) >= this.L.REPLIES_PER_DAY) return ok({ held: null, reason: 'limit' });
      const topics = (Array.isArray(b.topics) ? b.topics : [...TOPICS]).filter(t => TOPICS.has(t));
      if (!topics.length) return ok({ held: null, reason: 'no_topic' });
      const c = this.q(
        `SELECT id FROM conf WHERE state='waiting' AND owner<>? AND topic IN (${topics.map(() => '?').join(',')})
         AND NOT EXISTS (SELECT 1 FROM passed p WHERE p.conf_id=conf.id AND p.who=?)
         AND NOT EXISTS (SELECT 1 FROM block k WHERE k.who=? AND k.other=conf.owner)
         ORDER BY created LIMIT 1`, who, ...topics, who, who)[0];
      if (!c) return ok({ held: null, reason: 'empty' });
      this.run(`UPDATE conf SET state='assigned', holder=?, assigned=? WHERE id=?`, who, now, c.id);
    }
    return ok({ held: await this.heldView(who, now) });
  }

  async do_start(who, b, now) {
    const h = this.heldRow(who, String(b.id || ''));
    if (!h) return err(409, 'lost');
    if (h.state === 'assigned') this.run(`UPDATE conf SET state='reading', started=? WHERE id=?`, now, h.id);
    return ok({ deadline: (h.state === 'assigned' ? now : h.started) + this.L.REPLY_MS });
  }

  async do_pass(who, b, now) {
    const h = this.heldRow(who, String(b.id || ''));
    if (!h) return err(409, 'lost');
    const day = kstDay(now);
    if (this.used(who, 'pass', day) >= this.L.PASSES_PER_DAY) return err(429, 'limit');
    this.run('INSERT OR IGNORE INTO passed(conf_id, who) VALUES(?,?)', h.id, who);
    this.run(`UPDATE conf SET state='waiting', holder=NULL, assigned=NULL, started=NULL WHERE id=?`, h.id);
    this.bump(who, 'pass', day); this.tally('pass', 1, now);
    return ok({ passesLeft: Math.max(0, this.L.PASSES_PER_DAY - this.used(who, 'pass', day)) });
  }

  async do_reply(who, b, now) {
    const id = String(b.id || ''), text = typeof b.text === 'string' ? b.text : '';
    if (text.trim().length < this.L.REPLY_MIN || text.length > this.L.REPLY_MAX) return err(400, 'bad_text');
    if (CONTACT_ANY.test(text)) return err(422, 'contact');
    const h = this.heldRow(who, id);
    if (!h) return err(409, 'lost');                                // time ran out and it moved on, or never yours
    if (h.state !== 'reading') return err(409, 'not_started');
    const stats = checkTrace(text, b.log);
    if (!stats) return err(422, 'trace');                           // not a real keystroke history of exactly this text
    stats.blurs = Math.min(99, Math.max(0, Number(b.blurs) | 0));
    const day = kstDay(now);
    if (this.used(who, 'reply', day) >= this.L.REPLIES_PER_DAY) return err(429, 'limit');
    const [a, t] = await Promise.all([this.vault.seal(text, 'reply:' + id), this.vault.seal(JSON.stringify(b.log), 'trace:' + id)]);
    const h2 = this.heldRow(who, id);
    if (!h2 || h2.state !== 'reading') return err(409, 'lost');
    const deliver = this.L.MAIL_DELAY_MS === undefined ? nextDeliver(now) : now + this.L.MAIL_DELAY_MS;
    this.run('INSERT INTO reply(conf_id, ct, iv, tct, tiv, stats, created, deliver, author) VALUES(?,?,?,?,?,?,?,?,?)',
      id, a.ct, a.iv, t.ct, t.iv, JSON.stringify(stats), now, deliver, who);
    this.run(`UPDATE conf SET state='answered', holder=NULL, assigned=NULL, started=NULL WHERE id=?`, id);
    this.bump(who, 'reply', day); this.tally('reply', 1, now);
    if (this.used(who, 'reply', day) === 1) this.tally('repliers', 1, now);   // first reply today from this mailbox
    return ok({ deliverAt: deliver, repliesLeft: Math.max(0, this.L.REPLIES_PER_DAY - this.used(who, 'reply', day)), stats });
  }

  // The confessor opens the letter that has arrived. Opening it starts the 7-day countdown to deletion.
  async do_letter(who, b, now) {
    const c = this.q(`SELECT id FROM conf WHERE owner=? AND state='answered' ORDER BY created DESC LIMIT 1`, who)[0];
    if (!c) return ok({ letter: null });
    const r = this.q('SELECT * FROM reply WHERE conf_id=?', c.id)[0];
    if (!r || r.hidden || r.deliver > now) return ok({ letter: null });
    if (!r.read_at) { this.run('UPDATE reply SET read_at=? WHERE conf_id=?', now, c.id); r.read_at = now; }
    const [text, log] = await Promise.all([this.vault.open(r.ct, r.iv, 'reply:' + c.id), this.vault.open(r.tct, r.tiv, 'trace:' + c.id)]);
    return ok({
      letter: {
        text, log: JSON.parse(log), stats: JSON.parse(r.stats), warm: !!r.warm,
        thanked: this.q('SELECT 1 FROM thanks WHERE conf_id=?', c.id).length > 0, deleteAt: r.read_at + this.L.READ_KEEP_MS
      }
    });
  }

  async do_warm(who, b, now) {
    const c = this.q(`SELECT id FROM conf WHERE owner=? AND state='answered' ORDER BY created DESC LIMIT 1`, who)[0];
    const r = c && this.q('SELECT read_at, hidden FROM reply WHERE conf_id=?', c.id)[0];
    if (!r || r.hidden || !r.read_at) return err(409, 'not_read');
    if (!this.q('SELECT warm FROM reply WHERE conf_id=?', c.id)[0].warm) this.tally('warm', 1, now);
    this.run('UPDATE reply SET warm=1 WHERE conf_id=?', c.id);
    return ok({ warm: true });
  }

  async do_thanks(who, b, now) {
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (text.length < this.L.THANKS_MIN || text.length > this.L.THANKS_MAX) return err(400, 'bad_text');
    if (CONTACT_ANY.test(text)) return err(422, 'contact');
    const c = this.q(`SELECT id FROM conf WHERE owner=? AND state='answered' ORDER BY created DESC LIMIT 1`, who)[0];
    const r = c && this.q('SELECT read_at, hidden FROM reply WHERE conf_id=?', c.id)[0];
    if (!r || r.hidden || !r.read_at) return err(409, 'not_read');
    if (this.q('SELECT 1 FROM thanks WHERE conf_id=?', c.id).length) return err(409, 'already');
    const s = await this.vault.seal(text, 'thanks:' + c.id);
    if (this.q('SELECT 1 FROM thanks WHERE conf_id=?', c.id).length) return err(409, 'already');
    this.run('INSERT INTO thanks(conf_id, ct, iv, created) VALUES(?,?,?,?)', c.id, s.ct, s.iv, now);
    this.tally('thanks', 1, now);
    return ok({ thanked: true });
  }

  // kind "conf": the priest holding a confession reports it. kind "reply": the confessor reports the reply they received.
  // Reporting is the only way an item reaches the operator, and only that one item. Reporting blocks the other person.
  async do_report(who, b, now) {
    const kind = b.kind === 'reply' ? 'reply' : 'conf';
    if (!REASONS[kind].has(b.reason)) return err(400, 'bad_reason');
    const t = this.target(who, kind, b.id);
    if (!t) return err(409, 'lost');
    this.run('INSERT INTO report(id, kind, conf_id, target, reason, by, created) VALUES(?,?,?,?,?,?,?)', rid(), kind, t.confId, t.other, b.reason, who, now);
    this.run('INSERT OR REPLACE INTO block(who, other, at) VALUES(?,?,?)', who, t.other, now);
    this.tally(kind === 'conf' && b.reason === 'care' ? 'care' : 'report', 1, now);
    if (kind === 'conf') {
      if (b.reason === 'care') this.run(`UPDATE conf SET state='care', ct=x'', iv=x'', holder=NULL, assigned=NULL, started=NULL, ended=? WHERE id=?`, now, t.confId);
      else this.run(`UPDATE conf SET state='reported', holder=NULL, assigned=NULL, started=NULL, ended=? WHERE id=?`, now, t.confId);
    } else this.run('UPDATE reply SET hidden=1 WHERE conf_id=?', t.confId);
    return ok({ reported: true });
  }

  async do_block(who, b, now) {
    const kind = b.kind === 'reply' ? 'reply' : 'conf';
    const t = this.target(who, kind, b.id);
    if (!t) return err(409, 'lost');
    this.run('INSERT OR REPLACE INTO block(who, other, at) VALUES(?,?,?)', who, t.other, now);
    if (kind === 'conf') {
      this.run('INSERT OR IGNORE INTO passed(conf_id, who) VALUES(?,?)', t.confId, who);
      this.run(`UPDATE conf SET state='waiting', holder=NULL, assigned=NULL, started=NULL WHERE id=?`, t.confId);
    } else this.run('UPDATE reply SET hidden=1 WHERE conf_id=?', t.confId);
    return ok({ blocked: true });
  }

  target(who, kind, id) {
    if (kind === 'conf') {
      const h = this.heldRow(who, String(id || ''));
      return h ? { confId: h.id, other: h.owner } : null;
    }
    const c = this.q(`SELECT id FROM conf WHERE owner=? AND state='answered' ORDER BY created DESC LIMIT 1`, who)[0];
    const r = c && this.q('SELECT author, hidden, deliver FROM reply WHERE conf_id=?', c.id)[0];
    return r && !r.hidden && r.author ? { confId: c.id, other: r.author } : null;
  }

  // "Erase what I left here": my confession thread goes now. Replies I wrote stay with their readers but lose my link.
  async do_forget(who, b, now) {
    this.run('DELETE FROM duty WHERE who=?', who);
    this.run('DELETE FROM push WHERE who=?', who);
    this.run('DELETE FROM passed WHERE who=?', who);
    this.run(`UPDATE reply SET author='' WHERE author=?`, who);
    this.run(`UPDATE conf SET state='waiting', holder=NULL, assigned=NULL, started=NULL WHERE holder=?`, who);
    this.run(`DELETE FROM conf WHERE owner=? AND state<>'reported'`, who);
    this.run('DELETE FROM reply WHERE conf_id NOT IN (SELECT id FROM conf)');
    this.run('DELETE FROM thanks WHERE conf_id NOT IN (SELECT id FROM conf)');
    return ok({ forgotten: true });
  }

  /* ---------- operator: reads only what a person chose to report ---------- */
  async admin(name, token, b, now) {
    const want = this.env.ADMIN_TOKEN;
    if (!want || typeof want !== 'string' || want.length < 24) return err(404, 'unknown');
    if (typeof token !== 'string' || !safeEq(token, want)) return err(401, 'no');
    if (name === 'admin_resolve') {
      const r = this.q('SELECT * FROM report WHERE id=?', String(b.id || ''))[0];
      if (!r) return err(404, 'gone');
      if (b.action === 'delete') {
        if (r.kind === 'conf') this.run('DELETE FROM conf WHERE id=?', r.conf_id);
        else this.run('DELETE FROM reply WHERE conf_id=?', r.conf_id);
      }
      this.run('DELETE FROM report WHERE id=?', r.id);
      return ok({ done: true });
    }
    if (name === 'admin_stats') {
      const one = (sql, ...a) => (this.q(sql, ...a)[0] || {}).c | 0;
      const days = [];
      for (let i = 13; i >= 0; i--) days.push(kstDay(now - i * 864e5));
      const rows = {};
      for (const r of this.q('SELECT day, kind, n FROM daily WHERE day>=?', days[0])) (rows[r.day] = rows[r.day] || {})[r.kind] = r.n;
      const wait = this.q(`SELECT AVG(r.created - c.created) a, COUNT(*) c FROM reply r JOIN conf c ON c.id=r.conf_id WHERE r.created>?`, now - 7 * 864e5)[0] || {};
      const st = {};
      for (const r of this.q('SELECT state, COUNT(*) c FROM conf GROUP BY state')) st[r.state] = r.c;
      return ok({
        at: now,
        now: {
          duty: this.dutyCount(now),
          waiting: st.waiting | 0,
          inHand: (st.assigned | 0) + (st.reading | 0),
          toDeliver: one('SELECT COUNT(*) c FROM reply WHERE hidden=0 AND deliver>?', now),
          unread: one('SELECT COUNT(*) c FROM reply WHERE hidden=0 AND deliver<=? AND read_at IS NULL', now),
          pushSubs: one('SELECT COUNT(*) c FROM push'),
          openReports: one('SELECT COUNT(*) c FROM report'),
          totalConf: Number((this.q(`SELECT v FROM kv WHERE k='total_conf'`)[0] || {}).v) || 0,
          dayCap: this.L.DAY_CAP
        },
        replyWait7d: { avgMs: wait.c ? Math.round(wait.a) : null, n: wait.c | 0 },
        days: days.map(d => ({ day: d, ...(rows[d] || {}) }))
      });
    }
    const out = [];
    for (const r of this.q('SELECT * FROM report ORDER BY created DESC LIMIT 50')) {
      const o = { id: r.id, kind: r.kind, reason: r.reason, at: r.created };
      try {
        if (r.kind === 'conf') {
          const c = this.q('SELECT ct, iv, topic FROM conf WHERE id=?', r.conf_id)[0];
          if (c && c.ct && c.ct.byteLength) { o.topic = c.topic; o.text = await this.vault.open(c.ct, c.iv, 'conf:' + r.conf_id); }
        } else {
          const p = this.q('SELECT ct, iv, stats FROM reply WHERE conf_id=?', r.conf_id)[0];
          if (p) { o.text = await this.vault.open(p.ct, p.iv, 'reply:' + r.conf_id); o.stats = JSON.parse(p.stats); }
        }
      } catch { o.text = null; }
      out.push(o);
    }
    return ok({ reports: out });
  }
}
