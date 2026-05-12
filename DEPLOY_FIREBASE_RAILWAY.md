# Firebase Hosting + Railway

이 프로젝트는 다음 구조로 운영할 수 있습니다.

- 프런트: Firebase Hosting
- 백엔드: Railway Node 서비스
- 데이터베이스: Railway Postgres

## 1. Firebase Hosting

`public/env.js`는 다음 우선순위로 API 주소를 정합니다.

1. `?apiBaseUrl=https://...` 쿼리스트링
2. 브라우저 `localStorage`의 `omtApiBaseUrl`
3. `online-meeting-time.web.app` 또는 `firebaseapp.com`에서 접속한 경우 기본값
   - `https://online-meeting-time.onrender.com`
4. 그 외에는 same-origin

즉, Firebase Hosting에 먼저 배포해도 기본적으로 기존 Render API를 사용합니다.

배포:

```bash
firebase deploy --only hosting
```

## 2. Railway 백엔드

`server/` 폴더를 Railway에 배포합니다.

필수 환경변수:

```text
DATABASE_URL=...
DATABASE_SSL=true
APP_ORIGIN=https://online-meeting-time.web.app
FRONTEND_URL=https://online-meeting-time.web.app/
SYSTEM_ADMIN_CODE=원하는코드
```

선택 환경변수:

```text
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
```

## 3. Railway로 전환

Railway URL이 발급되면 아래 주소로 한 번 접속하면 됩니다.

```text
https://online-meeting-time.web.app/?apiBaseUrl=https://YOUR-RAILWAY-URL
```

이렇게 한 번 접속하면 `localStorage`에 저장되어 이후에도 같은 API를 사용합니다.

완전히 고정하려면 `public/env.js`의 기본값을 Railway URL로 바꾼 뒤 다시 Firebase Hosting에 배포하면 됩니다.
