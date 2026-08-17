# Life RPG 멀티플레이 서버

Firebase Realtime Database를 대체하는 전용 WebSocket 서버입니다.
접속한 플레이어들의 위치/상태를 받아서 같은 방(room)에 있는 다른 사람들에게 뿌려주는 "중계기" 역할만 합니다.
Firestore(계정/저장 데이터)나 거래소(market.js)는 이 서버와 무관하게 그대로 Firebase를 씁니다 — 바뀌는 건 실시간 위치 동기화뿐입니다.

## 왜 RTDB 대신 이걸로 바꿨나

- Firebase RTDB 무료(Spark) 플랜은 **동시 연결 100개, 월 다운로드 10GB** 제한이 있습니다. 8Hz로 위치를 계속 주고받는 실시간 게임에는 금방 부족해집니다.
- RTDB는 순수 key-value 저장소라, 나중에 전투/아이템 픽업/공유 자동차처럼 "여러 명이 같은 이벤트를 정확히 한 번씩만 봐야 하는" 로직을 넣기 까다롭습니다.
- 직접 만든 서버는 틱(tick) 단위로 완전히 제어할 수 있어서, 나중에 기능을 얼마든지 더 붙일 수 있습니다.

## 신뢰 모델 (꼭 읽어주세요)

이 서버는 클라이언트가 보내주는 `uid`/`name`을 그대로 믿습니다. Firebase Admin SDK로 로그인 토큰까지 검증하려면
서비스 계정 키를 서버에 올려야 하는데, 그러면 배포가 훨씬 복잡해집니다. 지금 이 게임 규모(친구들끼리 같이 하는
캐주얼 오픈월드)에서는 그 정도 보안까지는 과합니다.

- 최악의 경우 = 누가 다른 사람 uid를 흉내내서 "다른 사람 화면에서 내 캐릭터가 이상하게 보이는" 정도의 장난.
- 실제 계정 정보, 돈, 아이템(Firestore에 저장됨)에는 이 서버가 전혀 손을 대지 않습니다. 완전히 별개의 통로입니다.

나중에 진짜 불특정 다수에게 공개하는 서비스로 키우고 싶어지면, 그때 Firebase Admin SDK로 토큰 검증을 추가하면 됩니다.

## 배포 방법 (Render 기준, 무료 플랜으로 충분함)

1. 이 `server/` 폴더만 별도의 GitHub 저장소로 올립니다 (또는 기존 저장소에 같이 두고 Root Directory를 `server`로 지정해도 됩니다).
2. [render.com](https://render.com) 가입 → **New +** → **Web Service** → 방금 올린 저장소 선택.
3. 설정:
   - **Root Directory**: `server` (저장소 최상위에 같이 올렸다면)
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
4. 배포가 끝나면 `https://life-rpg-mp-server.onrender.com` 같은 주소가 생깁니다.
5. 게임 쪽 `js/multiplayer.js` 맨 위 `SERVER_URL`에 **`wss://`로 시작하는 같은 주소**를 넣습니다.
   (예: `https://xxx.onrender.com` → `wss://xxx.onrender.com`)
   - 게임이 `https://`로 서비스되는 이상 `ws://`(비암호화)는 브라우저가 차단합니다. 꼭 `wss://`를 쓰세요.
   - Render/Railway 모두 기본 도메인에 TLS(https/wss)가 자동으로 적용되니 별도 인증서 설정은 필요 없습니다.

무료 플랜은 일정 시간 요청이 없으면 서버가 잠들었다가, 다음 접속 때 10~50초 정도 걸려 깨어납니다.
사람이 몰리는 시간대에 계속 켜두고 싶다면 유료 플랜(월 몇 달러)으로 올리면 됩니다.

### 대안

- **Railway** (railway.app): Render와 거의 동일한 방식. 무료 크레딧 소진 후엔 카드 등록 필요.
- **Fly.io**: 더 세밀하게 제어하고 싶으면 이쪽도 무료 티어가 있습니다 (`fly launch`로 이 폴더를 그대로 배포 가능, Dockerfile 없이도 Node 앱을 자동 인식함).

## 로컬에서 테스트

```bash
cd server
npm install
npm start
# ws://localhost:8787 로 뜸 (로컬 테스트 땐 SERVER_URL을 ws://localhost:8787로 임시로 바꿔서 확인 가능)
```

## 서버 설정값 조절 (server/index.js 상단)

- `TICK_MS` (기본 100ms): 서버가 스냅샷을 브로드캐스트하는 주기. 낮출수록 더 부드럽지만 트래픽이 늘어남.
- `STALE_MS` (기본 8000ms): 이 시간 동안 갱신이 없으면 접속 끊김으로 판단.
- `MAX_STATE_BYTES` (기본 2000): 비정상적으로 큰 메시지를 걸러내는 방어선.

## 나중에 더 확장하고 싶다면

지금은 위치/모드/이름만 중계하지만, 같은 구조(`join`/`state`/`snapshot`) 위에 메시지 타입을 몇 개만 더 추가하면
NPC 처치 동기화, 공유 차량, 실시간 채팅 같은 것도 이 서버에 자연스럽게 얹을 수 있습니다.
