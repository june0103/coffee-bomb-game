# GoodGame

여러 명이 실시간으로 접속해 함께 즐기는 웹 미니게임 모음입니다. 방을 만들어 링크를 공유하면 친구들이 바로 참여할 수 있고, 커피 내기 등 소소한 벌칙 정하기에 어울리는 게임들로 구성되어 있습니다.

여기에 **우리 팀 맛집 기록**과 **주간 AI 리포트**가 더해져, 점심 메뉴를 고르고 한 주를 돌아보는 용도로도 쓰입니다.

Cloudflare Workers + Durable Objects 위에서 동작하며, 별도 데이터베이스 없이 Durable Object의 내장 스토리지로 모든 상태를 관리합니다.

## 게임 종류

| 게임 | 설명 |
| --- | --- |
| 폭탄 돌리기 (`bomb`) | 참가자끼리 순서대로 폭탄을 넘기다가 무작위 타이머(8~25초)가 끝나는 순간 폭탄을 들고 있는 사람이 패배합니다. |
| 반응속도 (`reaction`) | 화면이 초록색으로 바뀌는 순간 가장 먼저 반응해야 하며, 너무 일찍 누르면(false start) 즉시 최하위 처리됩니다. 가장 느린 사람이 패배합니다. |
| 시간감각 (`timesense`) | 목표 시간(10~30초)에 최대한 가깝게 버튼을 눌러야 하는 게임으로, 오차가 가장 큰 사람이 패배합니다. |
| 콩콩팥팥 (`stopwatch`) | 시작/정지를 두 번 눌러 얻은 두 자릿수(밀리초 끝자리)를 곱해 점수를 만드는 게임입니다. |
| 러시안 룰렛 (`pirate`) | 돌아가며 한 칸씩 고르다가 꽝을 뽑은 사람이 패배합니다. 칸이 줄어들수록 확률이 올라가는 압박이 재미 요소입니다. |

모든 게임은 시작에 **2명 이상**이 필요하며, 패배자는 자동으로 주간 랭킹에 기록됩니다.

> 러시안 룰렛의 칸 수는 인원에 따라 늘어납니다(1인당 8칸, 6의 배수로 반올림, 최대 60칸). 라운드가 평균적으로 칸의 절반쯤에서 끝나므로, 인원과 무관하게 **1인당 약 4턴**이 유지됩니다.
>
> `gameType` 식별자가 `pirate`인 것은 초기 이름이 "해적 룰렛"이었기 때문입니다. 이미 저장된 방과의 호환을 위해 표시 문구만 변경했습니다.

## 주요 기능

### 게임

- **방 생성/참여**: 랜덤 방 코드(`/r/{ROOM_ID}`)를 발급하고, 방 목록(`/`)에서 현재 열려 있는 방을 확인할 수 있습니다.
- **대기실에서 게임 변경**: 방장은 게임 시작 전 언제든 다른 게임으로 바꿀 수 있습니다.
- **실시간 동기화**: WebSocket으로 참가자 입장/퇴장, 게임 진행 상태(phase)를 모든 참가자에게 즉시 브로드캐스트합니다.
- **재접속 지원**: 클라이언트가 저장한 `rejoinId`로 같은 참가자로 다시 접속할 수 있습니다.

### 우리 팀 맛집 (`/places`)

- **카카오 검색으로 등록**: 회사 주변 800m 음식점을 거리순으로 검색합니다. 상호명을 직접 입력하지 않으므로 같은 가게가 여러 개로 쪼개지지 않습니다.
- **매장 / 배달 분리 평가**: 별 두 줄 중 어느 줄을 탭했는지로 유형과 점수가 한 번에 정해집니다. 한 사람이 같은 가게에 매장·배달 평점을 각각 남길 수 있습니다.
- **팀 추천 TOP**: 리뷰가 2개 이상 쌓인 곳만 순위에 오릅니다. 리뷰 1개짜리 5점이 1위를 차지하는 것을 막기 위함입니다.
- **리뷰 텍스트는 선택**: 별점만 남기고 나가도 됩니다.

### 주간 랭킹 및 AI 리포트 (`/ranking`)

- **주간 랭킹**: 매주(KST 기준 월요일 시작) 가장 많이 패배한 사람을 집계합니다. 게임 종류별 분포도 함께 기록됩니다.
- **AI 주간 리포트**: 매주 금요일 17시(KST)에 Workers AI가 그 주의 집계를 짧은 리포트로 정리합니다. 복사 버튼으로 슬랙에 바로 공유할 수 있습니다.

### 운영

- **자동 정리**: 6시간 이상 비활성 상태인 방은 자동 삭제되고, 랭킹 기록은 60일 후 정리됩니다(Durable Object Alarm).
- **자동 배포**: `main` 브랜치에 푸시하면 GitHub Actions가 Cloudflare에 배포합니다.

## 데이터 수명

저장 위치별로 수명이 다릅니다. **맛집·리뷰는 유일한 영구 데이터**이므로 Durable Object 설정을 변경할 때 주의가 필요합니다.

| Durable Object | 저장 내용 | 수명 |
| --- | --- | --- |
| `GameRoom` | 방·게임 진행 상태 | 비활성 6시간 후 삭제 |
| `Directory` | 활성 방 목록 | 방과 함께 정리 |
| `Leaderboard` | 주간 패배 기록, 주간 리포트 | 기록은 60일 후 정리 |
| `Restaurants` | 맛집·평점·리뷰 | **영구** |

## 외부 연동

### 카카오 로컬 API

음식점 검색에만 사용하며, **검색 결과는 저장하지 않습니다.** 카카오 운영정책상 API 응답은 매번 실시간으로 호출해야 하며 캐싱·영구 저장이 금지되어 있습니다.

DB에 남기는 값은 사용자가 직접 고른 **장소 ID · 상호명 · 카카오맵 링크** 세 가지뿐입니다. 주소·좌표·전화번호·카테고리는 저장하지 않으며, 음식 종류는 팀이 직접 고르는 자체 태그로 대체합니다.

### Workers AI

주간 리포트 생성에 사용합니다. **바인딩 방식이라 API 키나 별도 결제가 없으며**, 무료 플랜의 일일 허용량(10,000뉴런) 안에서 동작합니다. 주 1회 실행은 그 중 약 0.4%를 사용합니다.

모델 호출이 실패하면 결정론적 템플릿 리포트로 대체되므로, 리포트가 비는 주는 발생하지 않습니다.

## 프로젝트 구조

```
.
├── public/
│   ├── list.html               # 방 목록 페이지 (/)
│   ├── room.html               # 게임 방 페이지 (/r/:roomId)
│   ├── ranking.html            # 주간 랭킹 + AI 리포트 (/ranking)
│   ├── places.html             # 맛집 목록·검색·등록 (/places)
│   └── place.html              # 맛집 상세·평점 (/places/:placeId)
├── src/
│   ├── worker.js               # 라우팅, API, scheduled() 배치 진입점
│   ├── weeklyReport.js         # 주간 리포트 집계 및 생성
│   └── durable-objects/
│       ├── gameRoom.js         # 게임 방 상태/로직 (5종)
│       ├── directory.js        # 활성 방 목록 관리
│       ├── leaderboard.js      # 주간 패배 집계, 리포트 저장
│       └── restaurants.js      # 맛집·평점·리뷰
├── .github/workflows/deploy.yml # main 푸시 시 자동 배포
├── wrangler.toml               # DO 바인딩, 크론, Workers AI, 회사 좌표
└── package.json
```

## API

| Method | Path | 설명 |
| --- | --- | --- |
| GET | `/` | 방 목록 페이지 |
| GET | `/ranking` | 주간 랭킹 + 리포트 페이지 |
| GET | `/r/:roomId` | 게임 방 페이지 |
| GET | `/places` | 맛집 목록 페이지 |
| GET | `/places/:placeId` | 맛집 상세 페이지 |
| GET | `/api/rooms` | 활성 방 목록 조회 |
| POST | `/api/rooms` | 새 방 생성 (`name`, `gameType`) |
| GET/WS | `/api/rooms/:roomId/ws` | 방 WebSocket 연결 |
| GET | `/api/leaderboard` | 이번 주 랭킹 및 리포트 조회 |
| POST | `/api/report/regenerate` | 리포트 수동 재생성 (5분 쿨다운) |
| GET | `/api/places/search?q=` | 카카오 음식점 검색 (프록시) |
| GET | `/api/places` | 등록된 맛집 목록 |
| POST | `/api/places` | 맛집 태그 변경 |
| GET | `/api/places/:placeId` | 맛집 상세 + 리뷰 목록 |
| PUT | `/api/places/:placeId/review` | 평점 등록/수정 |
| DELETE | `/api/places/:placeId/review` | 평점 삭제 |

> 맛집은 **첫 평점과 함께 생성**됩니다. 등록과 평점을 나누면 평점 없이 이탈했을 때 빈 가게가 남기 때문입니다. 같은 이유로 마지막 리뷰를 삭제하면 가게도 함께 사라집니다.

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

맛집 검색을 로컬에서 쓰려면 프로젝트 루트에 `.dev.vars`를 만들고 카카오 REST API 키를 넣습니다. 이 파일은 `.gitignore`에 등록되어 있습니다.

```
KAKAO_REST_KEY=발급받은_키
```

> Windows PowerShell에서 `npx`가 실행 정책에 막히면 `npx.cmd`를 사용하세요.

### 배치 수동 실행

주간 리포트 배치는 로컬에서 아래 경로로 호출할 수 있습니다.

```bash
curl http://localhost:8787/cdn-cgi/handler/scheduled
```

### Cloudflare에 배포

`main` 브랜치에 푸시하면 자동 배포됩니다. 수동 배포는 아래와 같습니다.

```bash
npm run deploy
```

운영 환경에는 카카오 키를 secret으로 등록해야 합니다.

```bash
npx wrangler secret put KAKAO_REST_KEY
```

> Durable Object는 실행 중인 인스턴스가 재시작되어야 새 코드가 적용됩니다. 배포 직후 검증할 때는 잠시 여유를 두세요.

## 팀 작업 분담

| 담당자 | 역할 | 주요 작업 |
| --- | --- | --- |
| **고 준** | Cloudflare Workers / Durable Objects | `gameRoom.js` 게임 로직(폭탄, 반응속도, 러시안 룰렛), `directory.js` 방 목록, WebSocket 브로드캐스트 설계, `leaderboard.js` 랭킹 집계, `restaurants.js` 맛집·리뷰, `weeklyReport.js` AI 리포트, 카카오 API 연동, 배포 설정(`wrangler.toml`, GitHub Actions) |
| **조현우** | 프론트엔드 | `room.html`, `list.html`, `ranking.html` UI 구현, 콩콩팥팥(스톱워치)·시간감각 게임 로직 |
