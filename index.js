// =====================================================
// Life RPG 전용 멀티플레이 서버 (Firebase RTDB 대체)
// -----------------------------------------------------
// 순수 WebSocket 서버 (ws 라이브러리만 사용, 프레임워크 없음).
// 하는 일은 딱 하나: 접속한 플레이어들의 상태(위치/방향/모드 등)를 받아서
// 같은 방(room)에 있는 다른 사람들에게 그대로 뿌려주는 "중계기" 역할.
//
// 신뢰 모델(중요, 꼭 읽어주세요):
//   클라이언트가 보내주는 uid/name을 그대로 믿습니다. Firebase Admin SDK로 ID 토큰을
//   검증하려면 서비스 계정 키를 서버에 올려야 하는데, 그러면 배포 난이도가 확 올라갑니다.
//   지금 이 게임 규모(친구들끼리 같이 하는 캐주얼 오픈월드)에서는 그 정도 보안까지는
//   과합니다 - 누가 다른 사람 uid를 흉내내도 "다른 사람 화면에서 내 캐릭터가 이상하게
//   보이는" 정도의 장난이 최대치이고, 실제 계정/돈/아이템(Firestore)에는 전혀 손을 못 댑니다.
//   (Firestore 저장은 여전히 클라이언트→Firestore 규칙으로 보호되는 완전히 별개의 통로임)
//
// 프로토콜 (JSON 텍스트 메시지):
//   Client → Server
//     { type: 'join', uid, name, world }
//     { type: 'state', ...상태값 }     // x, y, rot, mode, moving, running, aiming, carImg, jetImg 등
//     { type: 'ping', t }
//   Server → Client
//     { type: 'welcome', uid }
//     { type: 'snapshot', players: { uid: {...} } }   // 주기적으로 방 전체 스냅샷 브로드캐스트
//     { type: 'leave', uid }
//     { type: 'pong', t }
// =====================================================

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8787;
const TICK_MS = 100; // 서버가 스냅샷을 브로드캐스트하는 주기 (초당 10회) - 클라 전송 주기(120ms)보다 살짝 빠르게
const STALE_MS = 8000; // 이 시간 동안 갱신이 없으면 접속이 끊긴 것으로 보고 정리
const MAX_STATE_BYTES = 2000; // 한 번의 state 메시지가 이 크기를 넘으면 무시 (비정상/악의적 트래픽 방지)

// world(room) 단위로 플레이어를 관리. 지금은 클라이언트가 항상 'default' 하나만 쓰지만,
// 나중에 여러 서버(방)로 나누고 싶으면 join 시 world 값만 다르게 보내면 됨.
const rooms = new Map(); // worldId -> Map(uid -> { ws, state, lastSeenAt })

function getRoom(worldId) {
  if (!rooms.has(worldId)) rooms.set(worldId, new Map());
  return rooms.get(worldId);
}

function removePlayer(worldId, uid) {
  const room = rooms.get(worldId);
  if (!room) return;
  if (!room.has(uid)) return;
  room.delete(uid);
  console.log(`[방=${worldId}] ${uid} 퇴장 (남은 인원: ${room.size})`);
  broadcastLeave(worldId, uid);
  if (room.size === 0) rooms.delete(worldId);
}

function broadcastLeave(worldId, uid) {
  const room = rooms.get(worldId);
  if (!room) return;
  const msg = JSON.stringify({ type: 'leave', uid });
  room.forEach((entry) => {
    if (entry.ws.readyState === WebSocket.OPEN) entry.ws.send(msg);
  });
}

// 매 TICK_MS마다 방마다 스냅샷을 만들어서 전체 브로드캐스트 (본인 것도 포함해서 보내고, 필터링은 클라이언트가 함 -
// 예전 RTDB 클라이언트 코드가 그렇게 짜여 있어서(uid === myUid 제외) 그대로 호환되게 맞춤)
function tick() {
  const now = Date.now();
  rooms.forEach((room, worldId) => {
    let changed = false;
    const players = {};
    room.forEach((entry, uid) => {
      if (now - entry.lastSeenAt > STALE_MS) {
        room.delete(uid);
        changed = true;
        broadcastLeave(worldId, uid);
        return;
      }
      players[uid] = entry.state;
    });
    if (room.size === 0) { rooms.delete(worldId); return; }
    const msg = JSON.stringify({ type: 'snapshot', players });
    room.forEach((entry) => {
      if (entry.ws.readyState === WebSocket.OPEN) entry.ws.send(msg);
    });
  });
}
setInterval(tick, TICK_MS);

const server = http.createServer((req, res) => {
  // 배포 플랫폼(Render 등)이 헬스체크로 그냥 GET / 을 찌르는 경우가 많아서 간단히 200으로 응답
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Life RPG multiplayer server OK\n');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let uid = null;
  let worldId = null;

  ws.on('message', (raw) => {
    if (raw.length > MAX_STATE_BYTES) return; // 비정상적으로 큰 메시지는 그냥 무시
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join') {
      uid = String(msg.uid || '').slice(0, 64);
      worldId = String(msg.world || 'default').slice(0, 64);
      if (!uid) return;
      const room = getRoom(worldId);
      room.set(uid, { ws, state: { name: String(msg.name || '플레이어').slice(0, 24) }, lastSeenAt: Date.now() });
      console.log(`[방=${worldId}] ${uid}(${msg.name}) 입장 (현재 인원: ${room.size}) - 방 안의 uid들: [${Array.from(room.keys()).join(', ')}]`);
      ws.send(JSON.stringify({ type: 'welcome', uid }));
      return;
    }

    if (msg.type === 'state') {
      if (!uid || !worldId) return; // join을 먼저 안 했으면 무시
      const room = rooms.get(worldId);
      if (!room || !room.has(uid)) {
        console.warn(`[state 무시됨] uid=${uid}, worldId=${worldId} - join 안 된 상태이거나 방이 없음`);
        return;
      }
      const entry = room.get(uid);
      // 화이트리스트 방식으로 필요한 필드만 받아서 저장 (임의 필드 주입 방지)
      const s = msg;
      entry.state = {
        x: Number(s.x) || 0,
        y: Number(s.y) || 0,
        rot: Number(s.rot) || 0,
        mode: typeof s.mode === 'string' ? s.mode.slice(0, 16) : 'walk',
        moving: !!s.moving,
        running: !!s.running,
        aiming: !!s.aiming,
        carImg: typeof s.carImg === 'string' ? s.carImg.slice(0, 64) : null,
        jetImg: typeof s.jetImg === 'string' ? s.jetImg.slice(0, 64) : null,
        name: typeof s.name === 'string' ? s.name.slice(0, 24) : (entry.state.name || '플레이어'),
      };
      entry.lastSeenAt = Date.now();
      if (!entry.gotFirstState) {
        entry.gotFirstState = true;
        console.log(`[방=${worldId}] ${uid} 첫 위치 정보 수신 (x=${entry.state.x}, y=${entry.state.y}, mode=${entry.state.mode})`);
      }
      return;
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
      return;
    }
  });

  ws.on('close', () => {
    if (uid && worldId) removePlayer(worldId, uid);
  });

  ws.on('error', () => {
    if (uid && worldId) removePlayer(worldId, uid);
  });
});

server.listen(PORT, () => {
  console.log(`[Life RPG MP 서버] 포트 ${PORT}에서 대기 중`);
});
