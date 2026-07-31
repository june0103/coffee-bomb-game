# Coffee Bomb Game

여러 명이 실시간으로 접속해 함께 즐기는 웹 미니게임 모음입니다. 방을 만들어 링크를 공유하면 친구들이 바로 참여할 수 있고, 커피 내기 등 소소한 벌칙 정하기에 어울리는 게임들로 구성되어 있습니다.

Cloudflare Workers + Durable Objects 위에서 동작하며, 별도 데이터베이스 없이 Durable Object의 내장 스토리지로 방 상태와 랭킹을 관리합니다.

## 게임 종류

| 게임 | 설명 |
| --- | --- |
| 폭탄 돌리기 (`bomb`) | 참가자끼리 순서대로 폭탄을 넘기다가 무작위 타이머(8~25초)가 끝나는 순간 폭탄을 들고 있는 사람이 패배합니다. |
| 반응속도 (`reaction`) | 화면이 초록색으로 바뀌는 순간 가장 먼저 반응해야 하며, 너무 일찍 누르면(false start) 즉시 최하위 처리됩니다. 가장 느린 사람이 패배합니다. |
| 시간감각 (`timesense`) | 목표 시간(10~30초)에 최대한 가깝게 버튼을 눌러야 하는 게임으로, 오차가 가장 큰 사람이 패배합니다. |
| 스톱워치 (`stopwatch`) | 시작/정지를 두 번 눌러 얻은 두 자릿수(밀리초 끝자리)를 곱해 점수를 만드는 게임입니다. |

패배자는 자동으로 주간 랭킹(리더보드)에 기록됩니다.

## 주요 기능

- **방 생성/참여**: 랜덤 방 코드(`/r/{ROOM_ID}`)를 발급하고, 방 목록(`/`)에서 현재 열려 있는 방을 확인할 수 있습니다.
- **실시간 동기화**: WebSocket으로 참가자 입장/퇴장, 게임 진행 상태(phase)를 모든 참가자에게 즉시 브로드캐스트합니다.
- **재접속 지원**: 클라이언트가 저장한 `rejoinId`로 같은 참가자로 다시 접속할 수 있습니다.
- **주간 랭킹**: 매주(KST 기준 월요일 시작) 가장 많이 패배(폭발/최하위)한 사람을 집계해 `/ranking` 페이지에서 보여줍니다.
- **자동 정리**: 6시간 이상 비활성 상태인 방은 자동으로 삭제되고, 랭킹 기록도 60일이 지나면 정리됩니다(Durable Object Alarm 사용).

## 프로젝트 구조

```
.
├── public/
│   ├── list.html      # 방 목록 페이지 (/)
│   ├── room.html       # 게임 방 페이지 (/r/:roomId)
│   └── ranking.html    # 주간 랭킹 페이지 (/ranking)
├── src/
│   ├── worker.js               # 라우팅 및 API 엔트리포인트
│   └── durable-objects/
│       ├── gameRoom.js         # 게임 방 상태/로직 (폭탄, 반응속도, 시간감각, 스톱워치)
│       ├── directory.js        # 활성 방 목록 관리
│       └── leaderboard.js      # 주간 패배 랭킹 집계
├── wrangler.toml       # Cloudflare Workers 설정 (Durable Objects 바인딩 등)
└── package.json
```

## API

| Method | Path | 설명 |
| --- | --- | --- |
| GET | `/` | 방 목록 페이지 |
| GET | `/ranking` | 랭킹 페이지 |
| GET | `/r/:roomId` | 게임 방 페이지 |
| GET | `/api/rooms` | 현재 활성화된 방 목록 조회 |
| POST | `/api/rooms` | 새 방 생성 (`name`, `gameType`) |
| GET/WS | `/api/rooms/:roomId/ws` | 방에 대한 WebSocket 연결 |
| GET | `/api/leaderboard` | 이번 주 랭킹 데이터 조회 |

## 시작하기

### 요구 사항

- Node.js
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (devDependency로 포함)

### 설치

```bash
npm install
```

### 로컬 개발 서버 실행

```bash
npm run dev
```

### Cloudflare에 배포

```bash
npm run deploy
```

배포 시 `wrangler.toml`에 정의된 `GameRoom`, `Directory`, `Leaderboard` Durable Object 바인딩이 함께 적용됩니다.
