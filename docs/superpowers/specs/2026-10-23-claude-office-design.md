# claude-office: 클로드가 일하는 모습을 사무실로 보기

## 목표

- 클로드 코드 세션 기록(JSONL)을 읽어 '무엇을 어떤 순서로 몇 초 동안 했나'를 픽셀아트 사무실 장면으로 보여 준다.
- 끝난 세션은 재생(배속·끌기), 진행 중인 세션은 실시간(1~2초 늦게)으로 따라간다.
- 한 화면에 세션 하나. 메인 클로드는 직원, 하위 에이전트는 인턴.
- 보는 사람은 이 PC의 사용자 한 명. 기록에 코드·경로·명령 결과가 그대로 있으므로 127.0.0.1에서만 연다.
- 클로드 코드 설정·훅은 건드리지 않는다. `~/.claude`는 읽기만 한다.
- 성공 기준:
  - 지난 작업(예: mini-apm '패널 켜고 끄기')을 열면 단계 순서·걸린 시간·실패와 재시도가 한눈에 보인다.
  - 진행 중인 세션을 열어 두면 새 단계가 2초 안에 화면에 붙는다.
  - 47MB짜리 실제 기록도 몇 초 안에 열린다.

## 한계(화면에도 적는다)

- 보여 주는 것은 기록에 남은 관찰 가능한 과정(도구 호출·입력·결과·토큰·하위 에이전트·스킬)이다. 모델 내부 계산은 아니다.
- 생각 내용은 대부분 기록에 남지 않는다(이 PC의 한 기록: 생각 466개 중 문장이 남은 것 29개). 생각은 시간·토큰으로 보이고, 문장은 남은 경우만.
- 문맥 크기 한도는 기록에 없으므로 막대는 추정(`CONTEXT_LIMIT`, 기본 200000).

## 기술

- Node 22, 의존성 없음(`node --test`). 브라우저는 순수 ES 모듈, SVG + CSS.
- 그림: Kenney CC0 팩 2개(Roguelike Indoor, Roguelike Characters, 16×16, 1px 간격)에서 쓸 시트만 `public/art/`에 두고 `public/art/LICENSE-kenney.txt`(CC0 원문)를 함께 둔다. 컴퓨터·모니터처럼 팩에 없는 것은 작은 픽셀 SVG로 직접 그린다.
- 참고(의존하지 않음): 공식 `session-report` 스킬의 `analyze-sessions.mjs`(Apache 2.0)가 정리한 기록 형식 규칙(아래 '기록 읽기 규칙').

## 1. 서버 (`server/`)

- `node server/server.js` → `http://127.0.0.1:7800`(`PORT`로 변경). 기록 폴더는 `CLAUDE_PROJECTS`(기본 `~/.claude/projects`).
- `GET /sessions` → `[{ id, project, title, mtime, size, live }]`, 최근 수정 순.
  - `id` = `<프로젝트 폴더>/<세션 uuid>`. `title` = 기록의 마지막 `ai-title`, 없으면 첫 사용자 요청 앞 40자.
  - `live` = 최근 60초 안에 기록 파일(또는 그 하위 에이전트 파일)이 바뀜.
- `GET /stream?session=<id>` (SSE)
  - 첫 메시지: `{ session, steps: [...전부], agents: [...] }`.
  - 이후 1초마다 본 기록과 `subagents/*.jsonl`의 크기를 보고, 늘어난 바이트만 읽어 새 단계·바뀐 단계(도구 결과 도착)를 `{ steps: [...] }`로 보낸다. 같은 `id`의 단계가 다시 오면 덮어쓴다.
  - 줄바꿈으로 끝나지 않은 마지막 조각은 남겨 두었다 다음에 붙인다.
  - 새로 생긴 하위 에이전트 파일은 처음부터 읽는다. 파일이 사라지면 `{ gone: true }`.
- `GET /step?session=<id>&step=<stepId>` → 그 단계의 전체 입력·결과(각각 최대 20KB, 넘으면 잘라서 `truncated: true`).
- `session`은 `<폴더>/<uuid>` 모양(영숫자·`-`·`_`·`.`만, `..` 불가)이고 결과 경로가 기록 폴더 안이어야 한다. 아니면 404.
- 정적 파일은 `public/`만, 밖으로 나가는 경로는 404.

### 기록 → 단계 (`server/parse.js`, 순수 함수 + 이어 읽기 상태)

단계:
```
{ id, who: 'main' | <agentId>, t, kind: 'user'|'think'|'tool'|'answer'|'compact',
  tool, place, summary, end, ok, tokens: { in, out, cache }, thinkMs, thinkText, skill }
```
- `user`: 사람이 쓴 요청. `summary` = 앞 80자.
- `think`: `thinking` 블록. `thinkMs` = 기록의 `thinkingDurationMs`, 문장이 있으면 `thinkText`(앞 200자).
- `tool`: `tool_use` 블록. `summary`는 도구별 한 줄(Read/Edit/Write → 파일 이름, Bash/PowerShell → 명령 앞 60자 또는 `description`, Grep/Glob → 패턴, Web → URL·검색어, Skill → 스킬 이름, Agent → `description`, AskUserQuestion → 첫 질문). `end`·`ok`는 같은 `tool_use_id`의 `tool_result`가 오면 채운다(`is_error` → `ok: false`). 결과가 없으면 진행 중.
- `answer`: 사용자에게 보인 `text` 블록. `summary` = 앞 80자.
- `compact`: `system` + `subtype: 'compact_boundary'`.
- `skill`: 기록의 `attributionSkill`.
- `tokens`: 응답(`requestId`) 단위. 그 응답의 첫 단계에만 싣는다.

자리(`place`):

| place | 이름 | 도구 |
|---|---|---|
| `shelf` | 서가 | Read |
| `desk` | 내 책상 | Edit, Write, NotebookEdit |
| `server` | 서버실 | Bash, PowerShell |
| `search` | 찾기 책상 | Grep, Glob |
| `window` | 창문 | WebFetch, WebSearch, `mcp__claude-in-chrome__*` |
| `manual` | 매뉴얼 선반 | Skill, ToolSearch |
| `meeting` | 회의실 | 사용자 요청, AskUserQuestion, 답변 |
| `intern` | 인턴 자리 | Agent |
| `misc` | 기타 | 그 밖의 모든 도구 |

`think`·`compact`는 자리가 없다(직원이 지금 자리에서 말풍선).

하위 에이전트(`agents`): `[{ id, role, type, parentStep, start, end }]`. `subagents/agent-<id>.meta.json`의 `toolUseId`로 부른 단계(`parentStep`)에 잇고, `role` = `description`, `type` = `agentType`. meta가 없으면 파일 이름에서 `id`만, `role` = `'인턴'`.

### 기록 읽기 규칙 (session-report 참고)

- 응답 하나가 여러 `assistant` 줄로 나뉜다. 같은 `requestId`끼리 한 응답이고, `output_tokens`는 그중 최대값을 쓴다.
- 사람이 쓴 요청 = `type: 'user'`이고 `isSidechain`·`isMeta`·`isCompactSummary`가 거짓이며, 내용이 문자열이거나 `text` 블록이고, `tool_result`·중단 표시(`[Request interrupted`로 시작)가 아닌 것.
- 이어서 연 세션은 이전 줄을 다시 쓴다 → `uuid`로 중복 제거.
- 모르는 `type`, JSON이 깨진 줄, 필드가 빠진 줄은 건너뛴다(서버는 죽지 않는다).

## 2. 화면 (`public/`)

배치(1920×1080):
- 위: 제목 `claude-office`, 세션 고르기(진행 중 ●, 기본은 진행 중인 가장 최근, 없으면 가장 최근), 요약(시작 시각·경과·도구 횟수·에러 수·출력 토큰·인턴 수), 오른쪽 끝 연결 상태.
- 가운데: 사무실(3×3 방, 각 방 = 자리 하나). 방 오른쪽 아래에 지금까지 쓴 횟수, 지금 쓰는 방은 테두리가 빛난다.
- 오른쪽(300px): 활동 피드. 단계마다 한 줄 `시각 아이콘 요약 (걸린 시간)`. 에러는 빨강, 인턴 단계는 보라로 들여 쓴다. 줄 또는 방을 누르면 같은 칸이 상세(입력·결과·토큰·걸린 시간)로 바뀌고 [← 피드]로 돌아간다.
- 아래: 재생 띠. ▶/❚❚, 배속(×1·×8·×32), 끌 수 있는 띠, 띠 위 표시(사용자 요청 파랑·에러 빨강·인턴 출발 보라), [● 실시간으로].

캐릭터:
- 직원(클로드): Kenney 캐릭터 조각을 겹친 정면 모습. 도구 단계가 시작되면 그 방으로 0.5초 동안 통통 튀며 이동, 머리 위 말풍선에 `summary`.
- 생각: 지금 자리에서 💭 말풍선(문장이 있으면 그 문장). 에러: ❗를 2초.
- 머리 위 문맥 막대: 마지막 응답의 입력 토큰(캐시 포함) / `CONTEXT_LIMIT`. 압축 단계에서 막대가 줄고 '📦 정리' 말풍선.
- 인턴: 다른 옷 색. Agent 단계가 시작되면 인턴 자리에 나타나 자기 단계대로 움직이고, 끝나면 회의실을 거쳐 사라진다. 여럿이면 조금씩 비켜 선다. 말풍선에 `role`.

재생:
- 재생 시계는 기록 시각을 따른다. 5초 넘게 아무 단계도 없던 구간은 1초로 줄인다(띠도 줄인 시간 기준).
- 지난 세션은 처음에서 멈춘 채 열리고, 진행 중인 세션은 실시간으로 열린다. 띠를 끌거나 ▶를 누르면 재생 모드, [● 실시간으로]는 맨 끝을 따라간다.
- 시계 위치에 맞는 장면(각 캐릭터의 자리·말풍선·방 횟수·피드)은 단계 목록과 시계만으로 계산한다(`public/scene.mjs`, 순수 함수).

그림:
- `public/art.mjs` 한 파일에 시트 좌표(가구·캐릭터 조각)와 그리기를 모은다. 그림을 바꾸려면 이 파일만 고친다.
- 픽셀은 `image-rendering: pixelated`, 3배 확대.

오류:
- 기록 폴더 없음 → '클로드 코드 기록을 찾지 못함(경로)'.
- 세션 파일 사라짐 → 피드에 '기록이 끊김'.
- SSE 끊김 → 브라우저가 다시 연결하고 첫 메시지로 전부 다시 받는다(화면 상태는 단계 목록에서 다시 계산).

## 테스트

- `test/parse.test.js`(작은 가짜 JSONL):
  - 도구 호출·결과 짝(결과 없음 = 진행 중, `is_error` → 실패), 생각 시간·문장, 압축, 자리 표(모르는 도구 → `misc`), `summary` 도구별.
  - 같은 `requestId` 여러 줄 → 토큰 한 번, `output_tokens` 최대값. `uuid` 중복 제거. 사람 요청 판정(도구 결과·메타·중단 표시 제외).
  - 모르는 type·깨진 줄·빈 줄 건너뜀.
  - 하위 에이전트: meta로 부른 단계 연결, meta 없으면 파일 이름.
- `test/tail.test.js`: 줄 덧붙이면 새 단계만, 반쪽 줄은 다음에, 도구 결과가 나중에 오면 그 단계가 갱신되어 다시 나옴, 하위 에이전트 파일이 나중에 생겨도 연결.
- `test/server.test.js`: `/sessions` 제목·live·순서, `/stream` 첫 메시지와 덧붙인 줄, `/step` 20KB 자르기, `session`에 `..`·다른 모양 → 404, 정적 파일 밖 → 404, 127.0.0.1에서만 받음.
- `test/scene.test.mjs`: 빈 시간 줄이기, 시계 위치별 직원·인턴 자리, 방 횟수, 생각·에러 말풍선, 인턴 등장·퇴장.
- Playwright(작업용 확인 스크립트): 가짜 세션 재생 → 직원이 방을 옮기고 피드가 쌓임, 기록에 줄 덧붙임 → 2초 안에 화면에, 인턴 등장·퇴장, 상세 열기, 페이지 오류 없음. 실제 기록(약 47MB) 열기 시간 측정.

## 범위 밖

여러 세션을 한 사무실에, 훅으로 즉시 반영, 낮·밤·날씨, 비용(원화), 내보내기(Markdown/JSON), LAN 열기, 걷기 애니메이션 시트.
