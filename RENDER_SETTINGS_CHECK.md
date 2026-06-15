# Render.com 설정 확인 가이드

## 문제
배포는 완료되었지만 `/v1/auth/register` 엔드포인트가 404 에러 발생

## 확인 사항

### 1. Render.com Settings 확인

Render.com 대시보드에서 `autosyrup-backend` → **"Settings"** 탭 확인:

#### Root Directory
- **올바른 설정:** `backend`
- **잘못된 설정:** (비어있음) 또는 다른 값

#### Build Command
- **올바른 설정:** `npm install`
- 또는: `cd backend && npm install` (Root Directory가 비어있는 경우)

#### Start Command
- **올바른 설정:** `npm start`
- 또는: `cd backend && npm start` (Root Directory가 비어있는 경우)

### 2. 서버 로그 확인

Render.com 대시보드에서 `autosyrup-backend` → **"Logs"** 탭 확인:

#### 정상적인 경우:
```
===========================================
🚀 오토시럽 백엔드 API 서버 시작
📡 포트: 3000
🌐 환경: production
===========================================
📋 등록된 라우트:
  GET  /
  POST /v1/auth/register
  POST /v1/auth/login
  POST /v1/events/parse/batch
===========================================
```

#### 문제가 있는 경우:
- 서버 시작 메시지가 없음
- 에러 메시지가 보임
- "Cannot find module" 같은 에러

### 3. 설정 수정 방법

1. Render.com 대시보드에서 `autosyrup-backend` 선택
2. **"Settings"** 탭 클릭
3. **"Build & Deploy"** 섹션 확인:
   - **Root Directory:** `backend`로 설정
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. 설정 변경 후 **"Save Changes"** 클릭
5. 자동으로 재배포 시작

### 4. 수동 재배포

설정을 변경한 후:
1. **"Manual Deploy"** → **"Deploy latest commit"** 클릭
2. Logs 탭에서 배포 진행 상황 확인
3. 서버 시작 메시지 확인

### 5. API 테스트

배포 완료 후 브라우저에서 테스트:

```
https://autosyrup-backend.onrender.com/
```

응답:
```json
{
  "status": "ok",
  "message": "오토시럽 백엔드 API 서버",
  "version": "1.0.0"
}
```

### 6. 문제가 계속되면

1. **Logs 탭**에서 전체 에러 메시지 확인
2. **Settings 탭**에서 모든 설정 재확인
3. **"Clear build cache & deploy"** 시도




























