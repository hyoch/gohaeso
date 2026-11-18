// 작은 고해소 — rules shared by the mailroom: limits, text checks, writing-trace verification.
// Pure functions only, so they can be tested without Cloudflare.

export const LIM = {
  CONF_MAX: 2000,
  REPLY_MIN: 20, REPLY_MAX: 1000,
  THANKS_MIN: 2, THANKS_MAX: 200,
  START_MS: 5 * 60e3,          // after being assigned, start reading within 5 minutes
  REPLY_MS: 10 * 60e3,         // after starting to read, send the reply within 10 minutes
  WAIT_MS: 48 * 3600e3,        // an unanswered confession is deleted after 48 hours
  READ_KEEP_MS: 7 * 864e5,     // thread is deleted 7 days after the confessor reads the reply
  UNREAD_KEEP_MS: 14 * 864e5,  // a reply nobody opens is deleted 14 days after it arrives
  TOMB_MS: 7 * 864e5,          // "expired" / "closed" notices stay 7 days so the confessor is told honestly
  REPORT_KEEP_MS: 30 * 864e5,  // reported items are kept 30 days for review, then deleted
  DAY_CAP: 60,                 // confessions accepted per day, first come first served
  CONF_PER_DAY: 1,             // per mailbox key
  REPLIES_PER_DAY: 3,
  PASSES_PER_DAY: 2,
  DUTY_TTL_MS: 120e3,          // a priest counts as on duty for 2 minutes after the last heartbeat
  MAX_BURST: 12,               // most characters one keystroke event may add (IME composition: double)
  MAX_EVENTS: 3000,
  MIN_MS_PER_CHAR: 30,         // a human cannot type faster than this on average
  RESTRICT_REPORTS: 3,         // distinct reporters (30 days) after which an author stops receiving confessions
  // calling priests by notification when a confession waits and nobody is on duty
  PRIEST_WAIT_MS: 10 * 60e3,   // a confession waits this long before anyone is called
  PRIEST_PING_GAP_MS: 2 * 3600e3, // the same confession calls again at most this often
  PRIEST_PER_PING: 3,          // priests called at a time
  PRIEST_GAP_MS: 6 * 3600e3,   // one priest is called at most this often
  PRIEST_KEEP_MS: 30 * 864e5,  // priest alerts switch themselves off after 30 days without a visit
  QUIET_FROM: 1, QUIET_TO: 8   // no calls between 01:00 and 08:00 Korea time
};

export const TOPICS = new Set(['rel', 'fam', 'work', 'self', 'ai', 'etc']);
export const REASONS = {
  conf: new Set(['care', 'contact', 'sexual', 'attack', 'minor', 'other']),
  reply: new Set(['ai', 'hurt', 'contact', 'sexual', 'preach', 'other'])
};

export const CRISIS = /(죽고\s*싶|죽어\s*버리|자살|자해|사라지고\s*싶|살기\s*싫|살고\s*싶지\s*않|끝내고\s*싶|목숨|투신|극단적\s*선택)/;
// What a confession may not carry: phone, e-mail, link. (Words like "인스타" are fine in a confession.)
export const CONTACT_STRICT = /(01[016789][-\s.]?\d{3,4}[-\s.]?\d{4})|([\w.+-]+@[\w-]+\.[a-z]{2,})|(https?:\/\/|www\.)/i;
// What a reply or thank-you may not carry: the above plus asking to move to another app.
export const CONTACT_ANY = /(01[016789][-\s.]?\d{3,4}[-\s.]?\d{4})|([\w.+-]+@[\w-]+\.[a-z]{2,})|(https?:\/\/|www\.)|(카톡|카카오톡|오픈채팅|인스타|텔레그램|디엠|\bdm\b)|(@[a-z0-9_.]{3,})/i;

const KST = 9 * 3600e3;
export const kstDay = ms => new Date(ms + KST).toISOString().slice(0, 10);

// Slow mail: letters go out at fixed "post times" (Korea time), never instantly.
// The next post time that is at least 30 minutes away.
// Few in the morning, many in the evening and late night, when most people write. Ascending within a day.
export const POST_TIMES = [[1, 0], [8, 0], [12, 30], [18, 0], [20, 30], [22, 0], [23, 30]];
export const MIN_WAIT_MS = 30 * 60e3;   // a letter waits at least 30 minutes for its post time
export function nextDeliver(ms) {
  const d = new Date(ms + KST);
  d.setUTCHours(0, 0, 0, 0);
  const day0 = d.getTime() - KST;                           // today 00:00 KST
  for (let add = 0; add < 3; add++) {
    for (const [h, m] of POST_TIMES) {
      const t = day0 + add * 864e5 + (h * 60 + m) * 60e3;
      if (t >= ms + MIN_WAIT_MS) return t;
    }
  }
  return ms + 864e5;
}

// Writing-trace events travel as [t, at, del, ins, composing]. Returns stats, or null when the trace is not a genuine
// keystroke-level history of exactly `text`.
export function checkTrace(text, log) {
  if (typeof text !== 'string' || !Array.isArray(log) || log.length < 1 || log.length > LIM.MAX_EVENTS) return null;
  let cur = '', prevT = -1;
  for (const e of log) {
    if (!Array.isArray(e) || e.length !== 5) return null;
    const [t, at, del, ins, c] = e;
    if (!Number.isInteger(t) || t < 0 || t > 6e6 || t < prevT) return null;
    if (!Number.isInteger(at) || !Number.isInteger(del) || at < 0 || del < 0 || at + del > cur.length) return null;
    if (c !== 0 && c !== 1) return null;
    if (typeof ins !== 'string' || ins.length > (c ? LIM.MAX_BURST * 2 : LIM.MAX_BURST)) return null;
    cur = cur.slice(0, at) + ins + cur.slice(at + del);
    prevT = t;
  }
  if (cur !== text) return null;
  if (prevT < text.length * LIM.MIN_MS_PER_CHAR) return null;
  return traceStats(log, text.length);
}

export function traceStats(log, len) {
  let active = 0, pauses = 0, fixes = 0, delChars = 0, run = false;
  const gaps = [];
  for (let i = 0; i < log.length; i++) {
    const [t, , del, ins, c] = log[i];
    const g = i ? t - log[i - 1][0] : 0;
    active += Math.min(g, 30000);
    if (g > 2000) pauses++;
    if (g > 0 && g < 2000) gaps.push(g);
    if (!c && del > 0 && !ins) { delChars += del; if (!run) fixes++; run = true; } else if (ins) run = false;
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1);
  const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / (gaps.length || 1));
  const cv = mean ? sd / mean : 0;
  const thin = len >= 80 && delChars / len < .02 && pauses <= 1 && cv < .45;
  return { active, pauses, fixes, delChars, thin, len };
}
