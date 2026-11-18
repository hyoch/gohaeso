// Pure rule checks (no server needed): node tests/rules.test.mjs
import { traceStats, checkTrace, nextDeliver } from '../src/rules.js';
let bad = 0; const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x))); if (!c) bad++; };

// iPhone Korean keyboard: each syllable step arrives as "delete one, insert one" within a few ms
const ios = [[0,0,0,'ㅇ',0],[300,0,1,'',0],[305,0,0,'우',0],[600,0,1,'',0],[604,0,0,'울',0],
             [1500,1,0,'ㅈ',0],[1800,1,1,'',0],[1803,1,0,'지',0],[4000,1,1,'',0],[4600,1,0,'어',0]];
const s = traceStats(ios, 2);
ok('iPhone syllable building is not counted as rewriting', s.fixes === 1 && s.delChars === 1, s);
ok('the trace still rebuilds the text', !!checkTrace('울어', ios));
// a real backspace then retype of the same Hangul letter, at human speed, still counts
const human = [[0,0,0,'가',0],[500,0,1,'',0],[900,0,0,'나',0]];
ok('a slow delete and retype counts once', traceStats(human, 1).fixes === 1, traceStats(human, 1));
// Latin text is unaffected
const latin = [[0,0,0,'a',0],[10,0,1,'',0],[12,0,0,'b',0]];
ok('non-Hangul quick swap still counts', traceStats(latin, 1).fixes === 1);
// post times
const K = 9 * 3600e3, at = s2 => Date.parse(s2 + ':00+09:00'), hm = t => new Date(t + K).toISOString().slice(11, 16);
ok('21:40 reply arrives 23:30', hm(nextDeliver(at('2026-11-18T21:40'))) === '23:30');
ok('00:40 reply arrives 08:00', hm(nextDeliver(at('2026-11-19T00:40'))) === '08:00');
console.log(bad ? `${bad} FAILED` : 'RULES PASSED'); process.exit(bad ? 1 : 0);
