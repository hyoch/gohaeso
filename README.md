# 작은 고해소

AI 디톡스 고해소. 붙여넣기도 AI 답장도 없이, 사람만 손수 대답하는 3D 성당 마당.

## 구조

| 경로 | 역할 |
| --- | --- |
| `site/page.html` | 페이지 원본 (화면, 3D 마당, 답장 쓰기, 소리) |
| `scripts/build.mjs` | 원본을 `public/index.html`로 감싸는 빌드 |
| `public/` | 배포되는 정적 파일 (`index.html`, `realtime.js`, `three.min.js`, `_headers`) |
| `src/worker.js` | 실시간 마당 서버 (Cloudflare Worker + Durable Object) |
| `wrangler.jsonc` | Cloudflare 설정 |

## 실시간 서버가 주고받는 것

위치, 줄 선 시각, 고민 색, 고양이 모양 번호, 당직 여부만 오간다. 서버는 허용된 항목과 형식만 통과시키고,
글자는 받지 않으며, 아무것도 저장하거나 기록하지 않는다. 고백 글은 기기 밖으로 나가지 않는다.

- 방: `lobby` 1개 + 마당 `yard-1` … `yard-99`. 마당 하나에 고해실 하나.
- 마당 정원 24명, 줄 최대 6명, 고해실 8분 제한 (규칙은 `site/page.html`에 있다).
- 같은 출처에서 온 접속만 받는다. 메시지는 600바이트, 초당 20개로 제한한다.

## 개발

```bash
npm install
npm run dev      # http://127.0.0.1:8787
npm run deploy   # Cloudflare에 배포 (wrangler 로그인 필요)
```

## Cloudflare 자동 배포 (GitHub 연결)

Cloudflare 대시보드 → Workers & Pages → Create → Import a repository 에서 이 저장소를 고른다.

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`

이후 `main`에 푸시할 때마다 자동으로 배포된다.

## 아직 미리보기인 것

당직 신부님께 보내기, 우편함의 고해, 우체통 편지, 촛불 봉헌은 화면만 있고 서버에 연결되지 않았다.
실제로 고백이 사람에게 전달되는 기능은 신고, 차단, 위기 대응, 개인정보 처리방침을 갖춘 뒤에 연다.

three.js r128 (MIT) 를 `public/three.min.js`로 함께 배포한다.
