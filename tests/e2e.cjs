const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const mk = async name => { const c = await b.newContext({ viewport: { width: 420, height: 950 }, deviceScaleFactor: 1 }); const p = await c.newPage();
    const errs = []; p.on('pageerror', e => errs.push(name + ': ' + e.message));
    p.on('console', m => m.type() === 'error' && !/favicon/.test(m.text()) && errs.push(name + ' console: ' + m.text()));
    await p.goto('http://127.0.0.1:8788/'); return { p, errs, name }; };
  const ok = (n, c, x) => console.log(c ? 'PASS' : 'FAIL', n, c ? '' : JSON.stringify(x ?? ''));
  const txt = (X, id) => X.p.evaluate(i => { const e = document.getElementById(i); return e ? (e.hidden ? '[hidden]' : e.textContent) : '[none]'; }, id);
  const vis = (X, id) => X.p.evaluate(i => { const e = document.getElementById(i); return !!e && !e.hidden; }, id);
  const A = await mk('A'), B = await mk('B'), C = await mk('C');
  await A.p.waitForTimeout(2500);
  ok('A is in live mail mode', await A.p.evaluate(() => window.GOHAESO.mailLive === true));
  ok('policy shows live variant, preview variant hidden', await A.p.evaluate(() => [...document.querySelectorAll('[data-live]')].every(e => !e.hidden || e.closest('[hidden]')) && [...document.querySelectorAll('[data-preview]')].every(e => e.hidden)));

  // --- A walks in and sends to a duty priest
  await A.p.click('#gateChips button:nth-child(5)'); await A.p.waitForTimeout(1200); await A.p.click('#join'); await A.p.waitForSelector('#write:not([hidden])', { timeout: 70000 });
  await A.p.click('#sendMode [data-m="duty"]');
  const SECRET = '친구 생일에 AI가 쓴 축하를 보냈는데 그게 더 미안해요 그리고 조금 외로워요';
  await A.p.fill('#confession', SECRET);
  await A.p.click('#send');
  await A.p.waitForSelector('#done:not([hidden])', { timeout: 15000 });
  ok('A: done view says it was handed in (not a fake assignment)', /우체통에 고해를 넣었어요/.test(await txt(A, 'reply')), await txt(A, 'reply'));
  { const cal = await A.p.evaluate(() => ({ shown: !document.getElementById('calBox').hidden, href: document.getElementById('calBtn').getAttribute('href') }));
    ok('A: calendar reminder offered with a post-time link', cal.shown && /^\/api\/remind\.ics\?at=\d{13}$/.test(cal.href), cal);
    const r = await A.p.evaluate(async h => { const x = await fetch(h); return [x.status, x.headers.get('content-type'), (await x.text()).includes('BEGIN:VEVENT')]; }, cal.href);
    ok('A: calendar link returns an event', r[0] === 200 && /text\/calendar/.test(r[1]) && r[2], r); }
  ok('A: live proof sentence shown, no preview wording', /암호화되어 서버에/.test(await txt(A, 'proofDuty')));
  ok('A: peek-mail button is gone (money/clicks cannot speed up mail)', !(await vis(A, 'peekRow')));
  await A.p.waitForTimeout(1500);
  ok('A: chip says waiting', /읽을 차례를 기다리고/.test(await txt(A, 'mailChip')), await txt(A, 'mailChip'));
  await A.p.click('#leave');

  // --- B: opens the reply tab and is handed A's confession
  await B.p.waitForTimeout(2000);
  await B.p.click('#tabReply'); await B.p.waitForFunction(() => document.getElementById('confText').textContent.length > 20 && !/불러오는/.test(document.getElementById('confText').textContent), null, { timeout: 15000 });
  ok('B: received A\'s confession text', (await txt(B, 'confText')) === SECRET, await txt(B, 'confText'));
  ok('B: countdown note shown', /안에 읽기 시작해 주세요/.test(await txt(B, 'assignNote')), await txt(B, 'assignNote'));
  ok('B: report button visible', await vis(B, 'safeConf'));
  await B.p.click('#listenBtn'); await B.p.waitForSelector('#compose:not([hidden])', { timeout: 45000 });
  ok('B: reply window note', /답장까지 \d+:\d\d 남았어요/.test(await txt(B, 'assignNote')), await txt(B, 'assignNote'));
  // pasting is blocked; typing works and is verified by the server
  await B.p.evaluate(() => { const t = document.getElementById('replyBox'); const dt = new DataTransfer(); dt.setData('text', '붙여넣은 글'); t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
  ok('B: paste leaves the box empty', (await B.p.inputValue('#replyBox')) === '');
  const REPLY = '그 무게를 혼자 들고 있었군요. 말해줘서 고마워요. 오늘은 조금만 덜 무거우면 그걸로 충분해요.';
  await B.p.click('#replyBox'); await B.p.keyboard.type(REPLY.slice(0, 20), { delay: 70 });
  await B.p.keyboard.press('Backspace'); await B.p.waitForTimeout(2300); await B.p.keyboard.type(REPLY[19] + REPLY.slice(20), { delay: 60 });
  ok('B: box holds exactly what was typed', (await B.p.inputValue('#replyBox')) === REPLY);
  await B.p.click('#sendReply'); await B.p.waitForSelector('#sent:not([hidden])', { timeout: 15000 });
  ok('B: sent, mail line shows a real arrival time', /느린 우편으로 .*에 도착해요/.test(await txt(B, 'mailLine')) && !/내일 아침 7시/.test(await txt(B, 'mailLine')), await txt(B, 'mailLine'));
  ok('B: proof line from server stats', /동안 · 1번 고쳐 쓰고 · [1-9]번 멈춰 생각하며/.test(await txt(B, 'proofLine')), await txt(B, 'proofLine'));

  // --- A comes back: the letter has arrived
  await A.p.reload(); await A.p.waitForTimeout(3500);
  ok('A: chip says a letter arrived', /편지가 왔어요/.test(await txt(A, 'mailChip')), await txt(A, 'mailChip'));
  ok('A: open-mail button present', await vis(A, 'openMail'));
  await A.p.click('#openMail'); await A.p.waitForSelector('#letter:not([hidden])', { timeout: 10000 });
  ok('A: letter text equals the reply', (await txt(A, 'letterText')) === REPLY, await txt(A, 'letterText'));
  { await A.p.click('#tabConfess');
    const st = await A.p.evaluate(() => ({ back: !!document.getElementById('backYard') }));
    ok('A: booth has a way back to the yard', st.back, st); }
  ok('A: own confession is shown above the letter', (await vis(A, 'myConfBox')) && (await txt(A, 'myConfText')) === SECRET && /내가 맡긴 고해/.test(await txt(A, 'myConfMeta')), await txt(A, 'myConfMeta'));
  await A.p.locator('#letter').screenshot({ path: require('path').join(require('os').tmpdir(), 'letter_myconf.png') });
  ok('A: proof line shows 1 fix + pauses', /1번 고쳐 쓰고/.test(await txt(A, 'letterProof')), await txt(A, 'letterProof'));
  await A.p.click('#letterReplay'); await A.p.waitForTimeout(600);
  const mid = await txt(A, 'letterText'); ok('A: replay is running (text is being rebuilt)', mid.length < REPLY.length + 3 && mid.length > 0, mid);
  await A.p.waitForFunction(r => document.getElementById('letterText').textContent === r, REPLY, { timeout: 25000 });
  ok('A: replay ends on the exact text', true);
  await A.p.click('#letterWarm'); await A.p.waitForTimeout(500);
  await A.p.click('#thanksBox'); await A.p.keyboard.type('덕분에 오늘은 덜 무거웠어요', { delay: 40 });
  await A.p.click('#thanksSend'); await A.p.waitForTimeout(1200);
  ok('A: thanks sent', /답례를 전했어요/.test(await txt(A, 'thanksMsg')), await txt(A, 'thanksMsg'));

  // --- B sees the candle and the thank-you
  await B.p.evaluate(() => document.dispatchEvent(new CustomEvent('gohaeso:poke'))); await B.p.waitForTimeout(1500);
  ok('B: inbox shows candle + thanks', (await vis(B, 'inbox')) && /밤을 1번 밝혔어요/.test(await txt(B, "inboxWarm")) && /덜 무거웠어요/.test(await txt(B, 'inboxThanks')), [await txt(B, 'inboxWarm'), await txt(B, 'inboxThanks')]);

  // --- C confesses; B reports it as a worrying one through the UI
  await C.p.waitForTimeout(2000);
  await C.p.click('#gateChips button:nth-child(1)'); await C.p.waitForTimeout(1200); await C.p.click('#join'); await C.p.waitForSelector('#write:not([hidden])', { timeout: 70000 });
  await C.p.click('#sendMode [data-m="duty"]'); await C.p.fill('#confession', '회사에서 제 실수를 동료 탓으로 돌렸어요'); await C.p.click('#send');
  await C.p.waitForSelector('#done:not([hidden])', { timeout: 15000 });
  await B.p.click('#anotherReply'); await B.p.waitForFunction(() => /동료 탓/.test(document.getElementById('confText').textContent), null, { timeout: 15000 });
  await B.p.click('#reportConf'); await B.p.click('#repReasons button:nth-child(1)');
  ok('B: care reason shows the help line', await vis(B, 'repCare'));
  await B.p.click('#repGo'); await B.p.waitForTimeout(2200);
  ok('B: report closed and the confession is gone from B', !(await vis(B, 'report')) && !/동료 탓/.test(await txt(B, 'confText')), await txt(B, 'confText'));
  await C.p.click('#leave'); await C.p.reload(); await C.p.waitForTimeout(3500);
  ok('C: care notice reached C and help opened', /걱정되는 마음/.test(await txt(C, 'mailChip')) && (await vis(C, 'help')), [await txt(C, 'mailChip'), await vis(C, 'help')]);

  // --- key management
  await A.p.click('#footPrivacy'); await A.p.click('#keyShow');
  const key = await A.p.inputValue('#keyField'); ok('A: key is shown on demand', /^[A-Za-z0-9_-]{43}$/.test(key));
  await A.p.click('#wipe'); ok('wipe keeps the mailbox key', await A.p.evaluate(() => !!localStorage.getItem('gohaeso.key')));
  const D = await mk('D'); await D.p.waitForTimeout(1500);
  await D.p.evaluate(async () => { await window.GOHAESO_API.call('POST', 'duty', { on: false }); localStorage.setItem('gohaeso.thread', '1'); document.dispatchEvent(new CustomEvent('gohaeso:poke')); });
  await D.p.waitForTimeout(1500);
  ok('D: farewell appears when a thread has been erased', await vis(D, 'farewell'));
  await D.p.click('#farewellOk'); await D.p.waitForTimeout(3300);
  ok('D: farewell burns away and does not return', !(await vis(D, 'farewell')) && (await D.p.evaluate(() => localStorage.getItem('gohaeso.thread'))) === null);
  const errs = [...A.errs, ...B.errs, ...C.errs].filter(e => !/WebSocket/.test(e)); console.log('errors', errs);
  await b.close();
})().catch(e => { console.error('E2E CRASH', e.message.slice(0,700)); process.exit(1); });
