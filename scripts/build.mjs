// Wraps site/page.html (the page body, shared with the Claude artifact) into public/index.html.
// Run: npm run build
import { readFileSync, writeFileSync } from 'node:fs';

let page = readFileSync(new URL('../site/page.html', import.meta.url), 'utf8');

const title = (page.match(/<title>([\s\S]*?)<\/title>/) || [, '작은 고해소'])[1].trim();
page = page.replace(/<title>[\s\S]*?<\/title>\s*/, '').replace(/<meta name="claude:[^>]*>\s*/g, '');

// Self-host the 3D library so no third party ever sees a visitor.
const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
if (!page.includes(CDN)) throw new Error('three.js script tag not found in site/page.html');
page = page.replace(CDN, '/three.min.js');

// Optional donation link (site/config.json). Left empty, no donation text or link appears anywhere.
let donate = '';
try { donate = String(JSON.parse(readFileSync(new URL('../site/config.json', import.meta.url), 'utf8')).donateUrl || ''); } catch (e) {}
if (donate && !/^https:\/\/[^\s"'<>\\]+$/.test(donate)) throw new Error('site/config.json donateUrl must be a plain https URL');
const donateTag = donate ? `<script>window.GOHAESO_DONATE=${JSON.stringify(donate)}</script>\n` : '';
const CANON = 'gohaeso.space';   // keep in sync with CANONICAL_HOST in wrangler.jsonc
const desc = 'AI 디톡스 고해소. 붙여넣기도 AI 답장도 없이, 사람만 손수 대답해요.';
const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
<meta property="og:url" content="https://${CANON}/">
<meta property="og:site_name" content="작은 고해소">
<meta property="og:locale" content="ko_KR">
<meta property="og:image" content="https://${CANON}/og.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="촛불 옆에 '여기서는 사람만 대답해요.'라고 적힌 작은 고해소 소개 그림">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="https://${CANON}/og.jpg">
<meta name="theme-color" content="#2a2140">
<script>if (location.hostname.endsWith('.workers.dev')) location.replace('https://${CANON}' + location.pathname + location.search + location.hash)</script>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="고해소">
<meta name="referrer" content="no-referrer">
<style>
:root { color-scheme: light; padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px) }
body { margin: 0; font: 14px/1.5 system-ui, sans-serif }
img { max-width: 100% }
[hidden] { display: none !important }
</style>
</head>
<body>
${donateTag}<script src="/realtime.js"></script>
<script src="/mail.js"></script>
${page}
</body>
</html>
`;
writeFileSync(new URL('../public/index.html', import.meta.url), html);
console.log(`public/index.html written (${(html.length / 1024).toFixed(0)} KB)`);
