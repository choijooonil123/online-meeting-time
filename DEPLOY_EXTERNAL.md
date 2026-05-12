# External Backend Deployment

이 버전은 `정적 프런트 + 외부 Node API + Postgres` 구조입니다.

## 1. API 서버 준비

`server/` 폴더를 별도 Node 서비스로 배포합니다.

- 권장: Render Web Service + Render Postgres
- 다른 선택지: Railway, Fly.io, Northflank

### 서버 환경변수

`server/.env.example` 기준으로 설정합니다.

- `DATABASE_URL`: Postgres 연결 문자열
- `DATABASE_SSL`: Render/Railway면 보통 `true`
- `APP_ORIGIN`: 프런트 주소
  - 예: `https://online-meeting-time.web.app`
- `FRONTEND_URL`: 학생 확인 링크에 들어갈 프런트 주소
  - 예: `https://online-meeting-time.web.app/`
- `SYSTEM_ADMIN_CODE`: 시스템 관리자 코드
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`: SMS 사용 시만 입력

### 서버 실행

```bash
cd server
npm install
npm start
```

헬스체크:

```text
GET /health
```

## 2. 프런트 API 주소 연결

`public/env.js`의 `apiBaseUrl`을 배포한 API 주소로 바꿉니다.

예:

```js
window.__APP_CONFIG__ = {
  apiBaseUrl: "https://online-meeting-time-api.onrender.com",
};
```

## 3. 프런트 배포

프런트는 정적 파일만 배포하면 됩니다.

### Firebase Hosting만 사용할 경우

Spark 플랜으로도 가능합니다.

```bash
firebase deploy --only hosting
```

### 다른 정적 호스팅 사용 가능

- Firebase Hosting
- Netlify
- Vercel
- GitHub Pages

## 4. 최초 접속 후 운영 순서

1. 시스템 관리자 로그인
2. 지도교수 목록 등록
3. 학생 명단 등록
4. 교수별 로그인 후 면담 가능 시간 등록

학생 명단 형식:

```text
20260001,홍길동,prof-1
20260002,김영희,prof-1
20260003,박민수
```

교수 목록 형식:

```text
prof-1,김교수,010-1111-1111,국문학과,1111
prof-1,김교수,010-1111-1111,국문학과,1111
```

## 5. 현재 구조에서 Blaze가 필요 없는 이유

- Firebase Hosting만 사용
- Cloud Functions 미사용
- Firestore 미사용
- 외부 API 서버와 Postgres로 예약/승인 로직 처리
