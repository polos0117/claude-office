# claude-office Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 클로드 코드 세션 기록(JSONL)을 읽어 픽셀아트 사무실 장면으로 재생·실시간 표시하는 로컬 사이트.

**Architecture:** Node 22 서버가 `~/.claude/projects`의 기록을 읽기만 하며 줄 단위로 '단계'로 바꾸고(parse), 파일 끝에 붙는 줄을 1초마다 이어 읽어(tail) SSE로 보낸다. 브라우저는 단계 목록과 시계만으로 장면을 계산하는 순수 함수(scene)와 Kenney 시트를 자르는 그림 모듈(art)로 사무실을 그린다.

**Tech Stack:** Node 22(의존성 없음, `node --test`), 순수 ES 모듈, canvas + DOM, Kenney CC0 16×16 시트, Playwright(확인 스크립트만, 커밋 안 함).

**Spec:** `docs/superpowers/specs/2026-10-23-claude-office-design.md`

## Global Constraints

- Node 22, 의존성 없음. 테스트는 `node --test`. Git Bash에서 `fnm exec --using=22 npm.cmd test`.
- 서버는 `127.0.0.1`에서만 연다. 기본 포트 7800(`PORT`), 기록 폴더 `~/.claude/projects`(`CLAUDE_PROJECTS`), 문맥 한도 200000(`CONTEXT_LIMIT`).
- `~/.claude`는 읽기만 한다(쓰기·고치기 금지). 클로드 코드 설정·훅을 건드리지 않는다.
- 상세(입력·결과)는 각각 최대 20KB(`20 * 1024` 글자), 넘으면 `truncated: true`.
- 진행 중 = 최근 60초 안에 기록(또는 하위 에이전트 파일)이 바뀜. 빈 시간 > 5000ms는 1000ms로 줄여 재생.
- 화면 글은 한국어. 그림은 Kenney CC0(`public/art/LICENSE-kenney.txt`), 시트 16×16·1px 간격, 3배 확대.
- 사용자의 다른 서버(mini-apm 7700)를 끄지 않는다. Playwright는 7811·7812 포트.

## Review Focus

1. 도구 이름이 `constructor`·`toString` 같은 객체 기본 이름 → 기타 자리(`misc`), 화면이 깨지지 않는다. (Task 1 테스트)
2. 수 MB짜리 도구 결과 한 줄 → 상세는 20KB로 잘리고, SSE로 보내는 단계는 요약만이라 작다. (Task 1 테스트)
3. 한글이 1초 읽기 경계에서 바이트 중간에 잘림 → 깨지지 않는다. (Task 2 테스트)
4. 기록 파일을 새로 써서 짧아지거나 지워짐 → 처음부터 다시 읽되 본 줄은 다시 안 나오고(uuid), 지워지면 '기록이 끊김'. (Task 2 테스트)
5. `meta.json`이 없는 옛 인턴 → 마지막 단계에서 끝난 것으로 보고 사무실을 떠난다(영원히 남지 않는다). (Task 2·5 테스트)

---

## 파일 구조

| 파일 | 하는 일 |
|---|---|
| `package.json` | 스크립트(`start`, `test`) |
| `server/parse.js` | 기록 한 줄 → 단계. 자리 표·요약·사람 요청 판정·상세 자르기 |
| `server/tail.js` | 파일 끝 이어 읽기(`createTail`), 세션 하나 = 본 기록 + 하위 에이전트(`createReader`) |
| `server/sessions.js` | 세션 목록·제목(`listSessions`), 세션 id → 파일(`resolveSession`) |
| `server/server.js` | HTTP: `/sessions`, `/stream`(SSE), `/step`, 정적 파일 |
| `public/scene.mjs` | 순수 함수: 재생 시간 줄이기(`timeline`), 그 순간 장면(`sceneAt`), 말풍선, 띠 표시 |
| `public/art.mjs` | 사무실 배치·Kenney 칸 좌표·그리기(`drawOffice`), 캐릭터 겹그림(`charLayers`), 자리 좌표(`spot`) |
| `public/index.html`, `public/app.mjs` | 화면: 세션 고르기, SSE, 사무실·피드·상세·재생 띠 |
| `public/art/indoor.png`, `public/art/chars.png`, `public/art/LICENSE-kenney.txt` | Kenney 시트와 CC0 표시 |
| `test/*.test.js`, `test/*.test.mjs` | 단위 테스트 |

---

### Task 1: 기록 → 단계 (parse)

**Files:**
- Create: `package.json`, `server/parse.js`
- Test: `test/parse.test.js`

**Interfaces:**
- Produces: `createParser(who = 'main')` → `{ line(text) → Step[], steps() → Step[], step(id) → Step|null, detail(id) → {input, result}|null, stepOfTool(toolUseId) → Step|null, title }`.
  - `Step = { id: '<who>:<n>', who, t, kind: 'user'|'think'|'tool'|'answer'|'compact', tool?, place?, summary?, end?, ok?, tokens?: {in,out,cache}, thinkMs?, thinkText?, skill? }`
  - 상세 칸 `{ text, truncated }`.
- Produces: `placeOf(tool)`, `summaryOf(tool, input)`, `humanText(rec)` → string|null, `cut(s, n)`, `MAX_DETAIL = 20480`.

- [ ] **Step 1: package.json과 실패하는 테스트**

`package.json`:
```json
{
  "name": "claude-office",
  "version": "0.1.0",
  "private": true,
  "description": "클로드 코드 세션 기록을 픽셀아트 사무실로 보여 준다",
  "scripts": {
    "start": "node server/server.js",
    "test": "node --test test/*.test.*"
  },
  "engines": { "node": ">=22" },
  "license": "MIT"
}
```

`test/parse.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createParser, placeOf, summaryOf, MAX_DETAIL } = require('../server/parse');

let u = 0;
const at = (s) => new Date(Date.UTC(2026, 9, 23, 1, 0, s)).toISOString();
const rec = (o) => JSON.stringify({ uuid: `u${u++}`, ...o });
const asst = (sec, blocks, extra = {}) =>
  rec({ type: 'assistant', timestamp: at(sec), requestId: extra.requestId ?? `r${u}`, message: { role: 'assistant', content: blocks, usage: extra.usage }, ...extra });
const human = (sec, content, extra = {}) => rec({ type: 'user', timestamp: at(sec), message: { role: 'user', content }, ...extra });
const result = (sec, id, content, isError = false) =>
  rec({ type: 'user', timestamp: at(sec), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });

test('도구 호출과 결과를 tool_use_id로 짝짓는다(결과 전 = 진행 중, is_error = 실패)', () => {
  const p = createParser();
  const [s] = p.line(asst(0, [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:\\a\\b\\app.mjs' } }]));
  assert.deepEqual(
    { kind: s.kind, tool: s.tool, place: s.place, summary: s.summary, end: s.end, ok: s.ok, who: s.who, id: s.id },
    { kind: 'tool', tool: 'Read', place: 'shelf', summary: 'app.mjs', end: null, ok: null, who: 'main', id: 'main:0' },
  );
  const [r] = p.line(result(3, 't1', 'file body'));
  assert.equal(r, s);
  assert.equal(s.end, Date.parse(at(3)));
  assert.equal(s.ok, true);
  assert.deepEqual(p.detail(s.id).result, { text: 'file body', truncated: false });
  assert.match(p.detail(s.id).input.text, /app\.mjs/);
  assert.equal(p.step(s.id), s);
  assert.equal(p.stepOfTool('t1'), s);
  p.line(asst(4, [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }]));
  const [e] = p.line(result(5, 't2', [{ type: 'text', text: 'boom' }], true));
  assert.equal(e.ok, false);
  assert.equal(p.detail(e.id).result.text, 'boom');
  assert.deepEqual(p.line(result(6, 't2', 'again')), []); // 같은 결과 두 번은 무시
  assert.deepEqual(p.line(result(6, 'nope', 'x')), []);
});

test('생각: 시간과(남아 있으면) 문장, 토큰은 같은 requestId의 첫 단계에 한 번(출력은 최대값)', () => {
  const p = createParser();
  const usage = (out) => ({ input_tokens: 10, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 });
  const [th] = p.line(asst(0, [{ type: 'thinking', thinking: '' }], { requestId: 'R', thinkingDurationMs: 1500, usage: usage(1) }));
  assert.equal(th.kind, 'think');
  assert.equal(th.thinkMs, 1500);
  assert.equal(th.thinkText, null);
  const out = p.line(asst(1, [{ type: 'text', text: '답변입니다' }], { requestId: 'R', usage: usage(42) }));
  assert.equal(out.length, 2); // 답변 단계 + 토큰이 바뀐 생각 단계
  assert.deepEqual(th.tokens, { in: 10, out: 42, cache: 105 });
  assert.equal(out[0].kind, 'answer');
  assert.equal(out[0].place, 'meeting');
  assert.equal(out[0].tokens, undefined);
  const [t2] = p.line(asst(2, [{ type: 'thinking', thinking: '  :has() 안에\n:has()는 못 쓴다 ' }], { requestId: 'R2' }));
  assert.equal(t2.thinkText, ':has() 안에 :has()는 못 쓴다');
  assert.match(p.detail(t2.id).result.text, /못 쓴다/);
});

test('사람이 쓴 요청만 user 단계(도구 결과·메타·압축 요약·중단 표시·하위 에이전트·빈 글 제외)', () => {
  const p = createParser();
  const got = [
    human(0, '패널 켜고 끄기 해줘'),
    human(1, [{ type: 'text', text: '배열 ' }, { type: 'text', text: '형태' }]),
    human(2, '<system-reminder>', { isMeta: true }),
    human(3, '요약…', { isCompactSummary: true }),
    human(4, '[Request interrupted by user]'),
    human(5, '하위 에이전트에게', { isSidechain: true }),
    human(6, '   '),
  ].flatMap((l) => p.line(l));
  assert.deepEqual(got.map((s) => [s.kind, s.place, s.summary]), [['user', 'meeting', '패널 켜고 끄기 해줘'], ['user', 'meeting', '배열 형태']]);
});

test('uuid 중복·깨진 줄·모르는 type·시각 없는 줄은 건너뛰고, 압축·제목·스킬은 읽는다', () => {
  const p = createParser();
  const line = human(0, '안녕');
  assert.equal(p.line(line).length, 1);
  assert.deepEqual(p.line(line), []);
  for (const bad of ['', '{oops', 'null', '42', '"str"', JSON.stringify({ type: 'mystery', timestamp: at(1), uuid: 'm' }), JSON.stringify({ type: 'user', uuid: 'nt', message: { content: 'x' } })])
    assert.deepEqual(p.line(bad), [], bad);
  assert.deepEqual(p.line(rec({ type: 'assistant', timestamp: at(2), message: null })), []);
  const [c] = p.line(rec({ type: 'system', subtype: 'compact_boundary', timestamp: at(3) }));
  assert.equal(c.kind, 'compact');
  p.line(JSON.stringify({ type: 'ai-title', aiTitle: '대시보드 패널 켜고 끄기' }));
  assert.equal(p.title, '대시보드 패널 켜고 끄기');
  const [s] = p.line(asst(4, [{ type: 'tool_use', id: 'k', name: 'Skill', input: { skill: 'superpowers:brainstorming' } }], { attributionSkill: 'superpowers:brainstorming' }));
  assert.equal(s.skill, 'superpowers:brainstorming');
  assert.equal(s.place, 'manual');
});

test('자리 표: 알려진 도구, 크롬 MCP는 창문, 모르는 도구·객체 기본 이름은 기타', () => {
  assert.equal(placeOf('Edit'), 'desk');
  assert.equal(placeOf('Write'), 'desk');
  assert.equal(placeOf('PowerShell'), 'server');
  assert.equal(placeOf('Glob'), 'search');
  assert.equal(placeOf('WebSearch'), 'window');
  assert.equal(placeOf('mcp__claude-in-chrome__navigate'), 'window');
  assert.equal(placeOf('ToolSearch'), 'manual');
  assert.equal(placeOf('Agent'), 'intern');
  assert.equal(placeOf('AskUserQuestion'), 'meeting');
  assert.equal(placeOf('mcp__claude_ai_Todoist__add-tasks'), 'misc');
  assert.equal(placeOf('constructor'), 'misc');
  assert.equal(placeOf('toString'), 'misc');
});

test('summary: 도구별 한 줄, 길면 자르고, 입력이 이상해도 문자열', () => {
  assert.equal(summaryOf('Edit', { file_path: '/a/b/index.html' }), 'index.html');
  assert.equal(summaryOf('Bash', { command: 'npm test', description: '테스트 실행' }), '테스트 실행');
  assert.equal(summaryOf('PowerShell', { command: 'x'.repeat(100) }).length, 60);
  assert.equal(summaryOf('Grep', { pattern: ':has\\(' }), ':has\\(');
  assert.equal(summaryOf('WebSearch', { query: 'kenney cc0' }), 'kenney cc0');
  assert.equal(summaryOf('WebFetch', { url: 'https://kenney.nl' }), 'https://kenney.nl');
  assert.equal(summaryOf('Skill', { skill: 'find-skills' }), 'find-skills');
  assert.equal(summaryOf('Agent', { description: 'Final review' }), 'Final review');
  assert.equal(summaryOf('AskUserQuestion', { questions: [{ question: '무엇을 고를까요?' }] }), '무엇을 고를까요?');
  assert.equal(summaryOf('mcp__x__y', {}), 'mcp__x__y');
  assert.equal(summaryOf('Read', null), '');
  assert.equal(summaryOf('AskUserQuestion', { questions: 'oops' }), '');
});

test('큰 결과는 상세에서 20KB로 자르고, 단계에는 요약만 싣는다', () => {
  const p = createParser();
  const [s] = p.line(asst(0, [{ type: 'tool_use', id: 'big', name: 'Bash', input: { command: 'cat huge' } }]));
  p.line(result(1, 'big', 'y'.repeat(MAX_DETAIL * 3)));
  const d = p.detail(s.id);
  assert.equal(d.result.text.length, MAX_DETAIL);
  assert.equal(d.result.truncated, true);
  assert.ok(JSON.stringify(s).length < 400);
});
```

- [ ] **Step 2: 실패 확인**

Run: `fnm exec --using=22 node --test test/parse.test.js`
Expected: FAIL — `Cannot find module '../server/parse'`

- [ ] **Step 3: 구현**

`server/parse.js`:
```js
// 클로드 코드 기록(JSONL) 한 줄 → 화면에 그릴 '단계'.
// 형식 규칙은 공식 session-report 스킬(analyze-sessions.mjs)이 정리한 것을 따른다.

const MAX_DETAIL = 20 * 1024; // 상세(입력·결과) 한 칸 최대 글자 수

const PLACES = new Map([
  ['Read', 'shelf'],
  ['Edit', 'desk'], ['Write', 'desk'], ['NotebookEdit', 'desk'],
  ['Bash', 'server'], ['PowerShell', 'server'],
  ['Grep', 'search'], ['Glob', 'search'],
  ['WebFetch', 'window'], ['WebSearch', 'window'],
  ['Skill', 'manual'], ['ToolSearch', 'manual'],
  ['AskUserQuestion', 'meeting'],
  ['Agent', 'intern'],
]);

function placeOf(tool) {
  if (PLACES.has(tool)) return PLACES.get(tool);
  if (String(tool).startsWith('mcp__claude-in-chrome__')) return 'window';
  return 'misc';
}

function cut(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
const base = (p) => String(p ?? '').split(/[\\/]/).pop();

function summaryOf(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  switch (tool) {
    case 'Read': case 'Edit': case 'Write': return cut(base(i.file_path), 60);
    case 'NotebookEdit': return cut(base(i.notebook_path), 60);
    case 'Bash': case 'PowerShell': return cut(i.description || i.command, 60);
    case 'Grep': case 'Glob': return cut(i.pattern, 60);
    case 'WebFetch': return cut(i.url, 60);
    case 'WebSearch': return cut(i.query, 60);
    case 'Skill': return cut(i.skill, 60);
    case 'Agent': return cut(i.description, 60);
    case 'AskUserQuestion': return cut(i.questions?.[0]?.question, 60);
    default: return cut(tool, 60);
  }
}

// 사람이 직접 쓴 요청이면 그 글, 아니면 null(도구 결과·메타·압축 요약·중단 표시·하위 에이전트)
function humanText(rec) {
  if (rec.type !== 'user' || rec.isSidechain || rec.isMeta || rec.isCompactSummary) return null;
  const c = rec.message?.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c) && c.length > 0 && c.every((b) => b?.type === 'text')) text = c.map((b) => b.text ?? '').join('\n');
  if (text === null || !text.trim() || text.startsWith('[Request interrupted')) return null;
  return text;
}

function clip(s) {
  const t = String(s ?? '');
  return t.length > MAX_DETAIL ? { text: t.slice(0, MAX_DETAIL), truncated: true } : { text: t, truncated: false };
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b?.type === 'text' ? b.text : `[${b?.type ?? '?'}]`)).join('\n');
  return JSON.stringify(content ?? '');
}

function createParser(who = 'main') {
  const steps = new Map();     // id → 단계(화면에 보내는 것)
  const details = new Map();   // id → { input, result } (누르면 보여 주는 것)
  const seen = new Set();      // uuid(이어 연 세션은 앞 줄을 다시 쓴다)
  const byTool = new Map();    // tool_use_id → 단계
  const byRequest = new Map(); // requestId → 토큰을 싣는 단계(응답 하나가 여러 줄로 나뉜다)
  let n = 0;
  let title = null;

  const add = (step, detail) => {
    step.id = `${who}:${n++}`;
    step.who = who;
    steps.set(step.id, step);
    if (detail) details.set(step.id, detail);
    return step;
  };

  function assistant(rec, t) {
    const out = [];
    const blocks = Array.isArray(rec.message?.content) ? rec.message.content : [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      let s = null;
      if (b.type === 'thinking') {
        s = add(
          { kind: 'think', t, thinkMs: Number.isFinite(rec.thinkingDurationMs) ? rec.thinkingDurationMs : null, thinkText: b.thinking ? cut(b.thinking, 200) : null },
          b.thinking ? { input: null, result: clip(b.thinking) } : null,
        );
      } else if (b.type === 'tool_use') {
        const tool = String(b.name ?? '?');
        s = add(
          { kind: 'tool', t, tool, place: placeOf(tool), summary: summaryOf(tool, b.input), end: null, ok: null },
          { input: clip(JSON.stringify(b.input ?? null, null, 2)), result: null },
        );
        if (b.id) byTool.set(b.id, s);
      } else if (b.type === 'text' && String(b.text ?? '').trim()) {
        s = add({ kind: 'answer', t, place: 'meeting', summary: cut(b.text, 80) }, { input: null, result: clip(b.text) });
      }
      if (!s) continue;
      if (rec.attributionSkill) s.skill = String(rec.attributionSkill);
      out.push(s);
    }
    const u = rec.message?.usage;
    if (u && typeof u === 'object') {
      const req = rec.requestId ?? rec.message?.id ?? rec.uuid;
      let s = byRequest.get(req);
      if (!s && out.length) {
        s = out[0];
        byRequest.set(req, s);
      }
      if (s) {
        const tok = { in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cache: (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) };
        s.tokens = s.tokens
          ? { in: Math.max(s.tokens.in, tok.in), out: Math.max(s.tokens.out, tok.out), cache: Math.max(s.tokens.cache, tok.cache) }
          : tok;
        if (!out.includes(s)) out.push(s);
      }
    }
    return out;
  }

  function user(rec, t) {
    const out = [];
    const c = rec.message?.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type !== 'tool_result') continue;
        const s = byTool.get(b.tool_use_id);
        if (!s || s.end !== null) continue;
        s.end = t;
        s.ok = b.is_error !== true;
        details.get(s.id).result = clip(resultText(b.content));
        out.push(s);
      }
    }
    const text = humanText(rec);
    if (text !== null) out.push(add({ kind: 'user', t, place: 'meeting', summary: cut(text, 80) }, { input: null, result: clip(text) }));
    return out;
  }

  // 한 줄 → 새로 생기거나 바뀐 단계들. 모르는 줄·깨진 줄은 []
  function line(text) {
    let rec;
    try {
      rec = JSON.parse(text);
    } catch {
      return [];
    }
    if (!rec || typeof rec !== 'object') return [];
    if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') {
      title = rec.aiTitle;
      return [];
    }
    if (typeof rec.uuid === 'string') {
      if (seen.has(rec.uuid)) return [];
      seen.add(rec.uuid);
    }
    const t = Date.parse(rec.timestamp);
    if (!Number.isFinite(t)) return [];
    if (rec.type === 'assistant') return assistant(rec, t);
    if (rec.type === 'user') return user(rec, t);
    if (rec.type === 'system' && rec.subtype === 'compact_boundary') return [add({ kind: 'compact', t })];
    return [];
  }

  return {
    line,
    steps: () => [...steps.values()],
    step: (id) => steps.get(id) ?? null,
    detail: (id) => details.get(id) ?? null,
    stepOfTool: (toolUseId) => byTool.get(toolUseId) ?? null,
    get title() {
      return title;
    },
  };
}

module.exports = { createParser, placeOf, summaryOf, humanText, cut, MAX_DETAIL };
```

- [ ] **Step 4: 통과 확인**

Run: `fnm exec --using=22 node --test test/parse.test.js`
Expected: PASS 7/7

- [ ] **Step 5: 커밋**

```bash
git add package.json server/parse.js test/parse.test.js
git commit -m "feat(server): 기록 한 줄을 단계로(도구 짝짓기·생각·토큰·사람 요청·자리 표)"
```

---

### Task 2: 이어 읽기와 세션 하나(tail)

**Files:**
- Create: `server/tail.js`
- Test: `test/tail.test.js`

**Interfaces:**
- Consumes: `createParser(who)` (Task 1) — `line`, `steps`, `step`, `detail`, `stepOfTool`, `title`.
- Produces: `createTail(file)` → `{ read() → string[] | null }` (null = 파일 없음).
- Produces: `createReader(file)` → `{ poll() → { steps: Step[], agents: Agent[], gone: boolean }, all() → { steps: Step[] (t 순), agents: Agent[] }, detail(stepId) → { step, input, result } | null, title }`.
  - `Agent = { id, role, type, parentStep, start, end }` (`end: null` = 아직 일하는 중).

- [ ] **Step 1: 실패하는 테스트**

`test/tail.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTail, createReader } = require('../server/tail');

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'office-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
let u = 0;
const at = (s) => new Date(Date.UTC(2026, 9, 23, 1, 0, s)).toISOString();
const rec = (o) => `${JSON.stringify({ uuid: `u${u++}`, ...o })}\n`;
const tool = (sec, id, name, input) => rec({ type: 'assistant', timestamp: at(sec), requestId: `r${u}`, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (sec, id, content) => rec({ type: 'user', timestamp: at(sec), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const human = (sec, text) => rec({ type: 'user', timestamp: at(sec), message: { role: 'user', content: text } });

test('tail: 붙은 줄만, 반쪽 줄은 다음 번에, 한글이 바이트 경계에서 잘려도 깨지지 않는다', (t) => {
  const f = path.join(tmp(t), 's.jsonl');
  fs.writeFileSync(f, '');
  const tail = createTail(f);
  assert.deepEqual(tail.read(), []);
  fs.appendFileSync(f, '{"a":1}\n{"b":');
  assert.deepEqual(tail.read(), ['{"a":1}']);
  const ko = Buffer.from('2,"k":"한글"}\n');
  const cutAt = ko.indexOf(Buffer.from('글')) + 1; // '글'의 첫 바이트 뒤에서 자른다
  fs.appendFileSync(f, ko.subarray(0, cutAt));
  assert.deepEqual(tail.read(), []);
  fs.appendFileSync(f, ko.subarray(cutAt));
  assert.deepEqual(tail.read(), ['{"b":2,"k":"한글"}']);
  assert.deepEqual(tail.read(), []);
});

test('tail: 파일이 없으면 null, 짧아지면 처음부터 다시', (t) => {
  const f = path.join(tmp(t), 's.jsonl');
  const tail = createTail(f);
  assert.equal(tail.read(), null);
  fs.writeFileSync(f, '{"a":1}\n{"b":2}\n');
  assert.equal(tail.read().length, 2);
  fs.writeFileSync(f, '{"c":3}\n');
  assert.deepEqual(tail.read(), ['{"c":3}']);
});

test('reader: 처음엔 전부, 이후엔 새 단계와 결과가 온 단계만, 상세', (t) => {
  const f = path.join(tmp(t), 'sess.jsonl');
  fs.writeFileSync(f, human(0, '해줘') + tool(1, 't1', 'Edit', { file_path: 'a.js' }));
  const r = createReader(f);
  assert.deepEqual(r.poll().steps.map((s) => s.kind), ['user', 'tool']);
  assert.deepEqual(r.poll(), { steps: [], agents: [], gone: false });
  fs.appendFileSync(f, result(2, 't1', 'ok') + tool(3, 't2', 'Bash', { command: 'npm test' }));
  const next = r.poll();
  assert.deepEqual(next.steps.map((s) => [s.tool, s.end !== null]), [['Edit', true], ['Bash', false]]);
  assert.equal(r.all().steps.length, 3);
  const det = r.detail(next.steps[0].id);
  assert.equal(det.step.tool, 'Edit');
  assert.equal(det.result.text, 'ok');
  assert.match(det.input.text, /a\.js/);
  assert.equal(r.detail('main:999'), null);
  assert.equal(r.detail('nobody:0'), null);
});

test('reader: 하위 에이전트 파일이 나중에 생겨도 읽고, meta로 부른 단계에 잇는다', (t) => {
  const d = tmp(t);
  const f = path.join(d, 'sess.jsonl');
  fs.writeFileSync(f, tool(0, 'call1', 'Agent', { description: 'Final review' }));
  const r = createReader(f);
  r.poll();
  const sub = path.join(d, 'sess', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const meta = (finished) => JSON.stringify({ agentType: 'general-purpose', description: 'Final review', toolUseId: 'call1', finished });
  fs.writeFileSync(path.join(sub, 'agent-abc123.jsonl'), tool(1, 's1', 'Read', { file_path: 'app.mjs' }) + result(4, 's1', 'body'));
  fs.writeFileSync(path.join(sub, 'agent-abc123.meta.json'), meta(false));
  const p = r.poll();
  assert.deepEqual(p.steps.map((s) => [s.who, s.tool]), [['abc123', 'Read']]);
  assert.deepEqual(p.agents, [{ id: 'abc123', role: 'Final review', type: 'general-purpose', parentStep: 'main:0', start: Date.parse(at(1)), end: null }]);
  assert.deepEqual(r.poll().agents, []); // 안 바뀌면 다시 안 보낸다
  fs.writeFileSync(path.join(sub, 'agent-abc123.meta.json'), meta(true));
  assert.equal(r.poll().agents[0].end, Date.parse(at(4)));
  assert.equal(r.detail('abc123:0').step.tool, 'Read');
});

test('reader: meta가 없는 옛 인턴은 이름 "인턴", 마지막 단계에서 끝남, 부른 단계 모름', (t) => {
  const d = tmp(t);
  const f = path.join(d, 'sess.jsonl');
  fs.writeFileSync(f, human(0, '해줘'));
  const sub = path.join(d, 'sess', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-old1.jsonl'), tool(1, 'x', 'Glob', { pattern: '*.js' }) + result(2, 'x', 'a.js') + tool(3, 'y', 'Read', { file_path: 'a.js' }));
  const [a] = createReader(f).poll().agents;
  assert.deepEqual(a, { id: 'old1', role: '인턴', type: null, parentStep: null, start: Date.parse(at(1)), end: Date.parse(at(3)) });
});

test('reader: 파일을 새로 써서 짧아져도 이미 본 줄은 다시 안 나온다(uuid)', (t) => {
  const f = path.join(tmp(t), 's.jsonl');
  const a = human(0, '하나');
  fs.writeFileSync(f, a + human(1, '둘'));
  const r = createReader(f);
  assert.equal(r.poll().steps.length, 2);
  fs.writeFileSync(f, a);
  assert.deepEqual(r.poll().steps, []);
  fs.appendFileSync(f, human(2, '셋'));
  assert.deepEqual(r.poll().steps.map((s) => s.summary), ['셋']);
});

test('reader: 기록 파일이 사라지면 gone, 그 뒤로도 gone', (t) => {
  const f = path.join(tmp(t), 'sess.jsonl');
  fs.writeFileSync(f, human(0, '해줘'));
  const r = createReader(f);
  r.poll();
  fs.rmSync(f);
  assert.equal(r.poll().gone, true);
  assert.equal(r.poll().gone, true);
});
```

- [ ] **Step 2: 실패 확인**

Run: `fnm exec --using=22 node --test test/tail.test.js`
Expected: FAIL — `Cannot find module '../server/tail'`

- [ ] **Step 3: 구현**

`server/tail.js`:
```js
// 파일 끝에 새로 붙은 줄만 읽는다(진행 중인 세션 따라가기). 세션 하나 = 본 기록 + subagents/*.jsonl
const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { createParser } = require('./parse');

function createTail(file) {
  let pos = 0;
  let rest = '';
  let dec = new StringDecoder('utf8'); // 한글이 읽기 경계에서 잘려도 다음 번에 이어 붙인다
  return {
    // 완성된 줄 목록. 파일이 없으면 null
    read() {
      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        return null;
      }
      if (size < pos) {
        // 새로 쓰여 짧아졌으면 처음부터(이미 본 줄은 parse가 uuid로 거른다)
        pos = 0;
        rest = '';
        dec = new StringDecoder('utf8');
      }
      if (size === pos) return [];
      const buf = Buffer.alloc(size - pos);
      const fd = fs.openSync(file, 'r');
      let off = 0;
      try {
        while (off < buf.length) {
          const n = fs.readSync(fd, buf, off, buf.length - off, pos + off);
          if (n === 0) break;
          off += n;
        }
      } finally {
        fs.closeSync(fd);
      }
      pos += off;
      rest += dec.write(buf.subarray(0, off));
      const lines = rest.split('\n');
      rest = lines.pop();
      return lines.filter((l) => l.trim());
    },
  };
}

function createReader(file) {
  const subDir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  const main = { tail: createTail(file), parser: createParser('main') };
  const subs = new Map(); // agentId → { tail, parser, info }
  let gone = false;

  function agentInfo(id, sub) {
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(subDir, `agent-${id}.meta.json`), 'utf8'));
    } catch {
      // meta가 없는 옛 기록: 파일 이름만으로
    }
    if (!meta || typeof meta !== 'object') meta = null;
    let start = null;
    let last = null;
    for (const s of sub.parser.steps()) {
      if (start === null || s.t < start) start = s.t;
      const e = s.end ?? s.t;
      if (last === null || e > last) last = e;
    }
    return {
      id,
      role: typeof meta?.description === 'string' ? meta.description : '인턴',
      type: typeof meta?.agentType === 'string' ? meta.agentType : null,
      parentStep: (meta && main.parser.stepOfTool(meta.toolUseId)?.id) ?? null,
      start,
      end: meta && meta.finished !== true ? null : last, // meta가 없으면 마지막 단계에서 끝난 것으로 본다
    };
  }

  // 늘어난 줄을 읽어 새로 생기거나 바뀐 단계·인턴만 돌려준다
  function poll() {
    if (gone) return { steps: [], agents: [], gone: true };
    const lines = main.tail.read();
    if (lines === null) {
      gone = true;
      return { steps: [], agents: [], gone: true };
    }
    const changed = new Set();
    for (const l of lines) for (const s of main.parser.line(l)) changed.add(s);
    let files = [];
    try {
      files = fs.readdirSync(subDir);
    } catch {
      // 하위 에이전트 없음
    }
    const agents = [];
    for (const f of files) {
      const m = /^agent-([\w-]+)\.jsonl$/.exec(f);
      if (!m) continue;
      let sub = subs.get(m[1]);
      if (!sub) {
        sub = { tail: createTail(path.join(subDir, f)), parser: createParser(m[1]), info: null };
        subs.set(m[1], sub);
      }
      for (const l of sub.tail.read() ?? []) for (const s of sub.parser.line(l)) changed.add(s);
      const info = agentInfo(m[1], sub);
      if (JSON.stringify(info) !== JSON.stringify(sub.info)) {
        sub.info = info;
        agents.push(info);
      }
    }
    return { steps: [...changed], agents, gone: false };
  }

  const parsers = () => [main.parser, ...[...subs.values()].map((s) => s.parser)];

  return {
    poll,
    all: () => ({
      steps: parsers().flatMap((p) => p.steps()).sort((a, b) => a.t - b.t),
      agents: [...subs.values()].map((s) => s.info).filter(Boolean),
    }),
    detail(stepId) {
      const id = String(stepId);
      const who = id.slice(0, id.lastIndexOf(':'));
      const p = who === 'main' ? main.parser : subs.get(who)?.parser;
      const step = p?.step(id);
      if (!step) return null;
      const d = p.detail(id);
      return { step, input: d?.input ?? null, result: d?.result ?? null };
    },
    get title() {
      return main.parser.title;
    },
  };
}

module.exports = { createTail, createReader };
```

- [ ] **Step 4: 통과 확인**

Run: `fnm exec --using=22 node --test test/tail.test.js`
Expected: PASS 7/7

- [ ] **Step 5: 커밋**

```bash
git add server/tail.js test/tail.test.js
git commit -m "feat(server): 기록 끝 이어 읽기와 세션 하나(본 기록 + 하위 에이전트)"
```

---

### Task 3: 세션 목록과 세션 id(sessions)

**Files:**
- Create: `server/sessions.js`
- Test: `test/sessions.test.js`

**Interfaces:**
- Consumes: `humanText(rec)`, `cut(s, n)` (Task 1).
- Produces: `listSessions(root, now = Date.now())` → `Session[] | null` (null = 기록 폴더 없음), 최근 순.
  - `Session = { id: '<폴더>/<uuid>', project, title, mtime, size, live }`
- Produces: `resolveSession(root, id)` → 파일 경로 | null.

- [ ] **Step 1: 실패하는 테스트**

`test/sessions.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listSessions, resolveSession } = require('../server/sessions');

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'office-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
let u = 0;
const rec = (o) => `${JSON.stringify({ uuid: `u${u++}`, ...o })}\n`;
const human = (text) => rec({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: text } });
const title = (s) => `${JSON.stringify({ type: 'ai-title', aiTitle: s })}\n`;
const setTime = (f, ms) => fs.utimesSync(f, new Date(ms), new Date(ms));

test('listSessions: 최근 순(하위 에이전트 파일 포함), 제목(ai-title → 첫 요청 40자 → 없음), live는 60초', (t) => {
  const root = tmp(t);
  fs.mkdirSync(path.join(root, 'C--proj'));
  fs.mkdirSync(path.join(root, 'D--other'));
  const a = path.join(root, 'C--proj', 'aaa.jsonl');
  const b = path.join(root, 'C--proj', 'bbb.jsonl');
  const c = path.join(root, 'D--other', 'ccc.jsonl');
  fs.writeFileSync(a, human('첫 요청') + title('옛 제목') + title('패널 켜고 끄기'));
  fs.writeFileSync(b, human('대시보드 고쳐줘'.repeat(10)));
  fs.writeFileSync(c, rec({ type: 'mystery' }));
  fs.writeFileSync(path.join(root, 'C--proj', 'empty.jsonl'), '');
  fs.writeFileSync(path.join(root, 'C--proj', 'notes.txt'), 'x');
  const now = Date.now();
  setTime(a, now - 10_000);
  setTime(b, now - 300_000);
  setTime(c, now - 3_600_000);
  const sub = path.join(root, 'C--proj', 'bbb', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-x.jsonl'), human('일'));
  setTime(path.join(sub, 'agent-x.jsonl'), now - 5_000);

  const list = listSessions(root, now);
  assert.deepEqual(list.map((s) => [s.id, s.project, s.live]), [
    ['C--proj/bbb', 'C--proj', true],
    ['C--proj/aaa', 'C--proj', true],
    ['D--other/ccc', 'D--other', false],
  ]);
  assert.equal(list[0].title.length, 40);
  assert.ok(list[0].title.startsWith('대시보드 고쳐줘'));
  assert.equal(list[1].title, '패널 켜고 끄기');
  assert.equal(list[2].title, '(제목 없음)');
  assert.ok(list[1].size > 0);
  assert.equal(listSessions(path.join(root, 'nope'), now), null);
});

test('resolveSession: <폴더>/<uuid> 모양이고 기록 폴더 안의 있는 파일만', (t) => {
  const root = tmp(t);
  fs.mkdirSync(path.join(root, 'C--p'));
  fs.writeFileSync(path.join(root, 'C--p', 's1.jsonl'), '');
  fs.writeFileSync(path.join(root, 'outside.jsonl'), '');
  assert.equal(resolveSession(root, 'C--p/s1'), path.join(root, 'C--p', 's1.jsonl'));
  for (const bad of ['C--p/nope', '../x/s1', 'C--p/../outside', '..', 'C--p/..', 'C--p/s1/extra', 'C--p\\s1', '', null, undefined, '../C--p/s1'])
    assert.equal(resolveSession(root, bad), null, String(bad));
});
```

- [ ] **Step 2: 실패 확인**

Run: `fnm exec --using=22 node --test test/sessions.test.js`
Expected: FAIL — `Cannot find module '../server/sessions'`

- [ ] **Step 3: 구현**

`server/sessions.js`:
```js
// ~/.claude/projects 아래 세션 목록, 세션 id(<폴더>/<uuid>) → 기록 파일
const fs = require('node:fs');
const path = require('node:path');
const { humanText, cut } = require('./parse');

const LIVE_MS = 60 * 1000;  // 이 안에 바뀐 세션은 '진행 중'
const PEEK = 256 * 1024;    // 제목을 찾으려고 읽는 앞·뒤 크기
const titles = new Map();   // file → { mtime, title } ponytail: 세션 파일 수만큼만 커진다

function peek(file, size, fromEnd) {
  const n = Math.min(PEEK, size);
  const buf = Buffer.alloc(n);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, n, fromEnd ? size - n : 0);
  } finally {
    fs.closeSync(fd);
  }
  return buf.toString('utf8').split('\n'); // 앞뒤로 잘린 줄은 JSON.parse에서 걸러진다
}

const parse = (l) => {
  try {
    return JSON.parse(l);
  } catch {
    return null;
  }
};

// 제목: 끝부분의 마지막 ai-title, 없으면 앞부분의 첫 사람 요청 앞 40자
function titleOf(file, size) {
  const found = peek(file, size, true).filter((l) => l.includes('"ai-title"')).map(parse).filter((r) => typeof r?.aiTitle === 'string');
  if (found.length) return found.at(-1).aiTitle;
  for (const l of peek(file, size, false)) {
    const r = parse(l);
    const text = r && typeof r === 'object' ? humanText(r) : null;
    if (text) return cut(text, 40);
  }
  return '(제목 없음)';
}

function newestMtime(file, mtime) {
  const sub = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  let m = mtime;
  try {
    for (const f of fs.readdirSync(sub)) m = Math.max(m, fs.statSync(path.join(sub, f)).mtimeMs);
  } catch {
    // 하위 에이전트 없음
  }
  return m;
}

function listSessions(root, now = Date.now()) {
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return null; // 기록 폴더 없음
  }
  const out = [];
  for (const p of projects) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(root, p.name)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(root, p.name, f);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size === 0) continue;
      let c = titles.get(file);
      if (!c || c.mtime !== st.mtimeMs) {
        c = { mtime: st.mtimeMs, title: titleOf(file, st.size) };
        titles.set(file, c);
      }
      const mtime = newestMtime(file, st.mtimeMs);
      out.push({ id: `${p.name}/${f.slice(0, -'.jsonl'.length)}`, project: p.name, title: c.title, mtime, size: st.size, live: now - mtime < LIVE_MS });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const ID = /^([\w.-]+)\/([\w.-]+)$/;

function resolveSession(root, id) {
  const m = ID.exec(String(id ?? ''));
  if (!m || m[1].includes('..') || m[2].includes('..')) return null;
  const base = path.resolve(root);
  const file = path.resolve(base, m[1], `${m[2]}.jsonl`);
  if (!file.startsWith(base + path.sep)) return null;
  return fs.existsSync(file) ? file : null;
}

module.exports = { listSessions, resolveSession, LIVE_MS };
```

- [ ] **Step 4: 통과 확인**

Run: `fnm exec --using=22 node --test test/sessions.test.js`
Expected: PASS 2/2

- [ ] **Step 5: 커밋**

```bash
git add server/sessions.js test/sessions.test.js
git commit -m "feat(server): 세션 목록(제목·진행 중)과 세션 id 검사"
```

---

### Task 4: HTTP 서버

**Files:**
- Create: `server/server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `listSessions`, `resolveSession` (Task 3), `createReader` (Task 2).
- Produces: `createOfficeServer({ root, contextLimit = 200000, pollMs = 1000, publicDir })` → `{ server, close() }`.
  - `GET /sessions` → `{ root, found, sessions }`
  - `GET /stream?session=<id>` → SSE. 첫 메시지 `{ session, title, contextLimit, steps, agents, gone }`, 이후 `{ steps, agents }` 또는 `{ gone: true }`.
  - `GET /step?session=<id>&step=<stepId>` → `{ step, input, result }` 또는 404.

- [ ] **Step 1: 실패하는 테스트**

`test/server.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOfficeServer } = require('../server/server');

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'office-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
async function start(t, root, opts = {}) {
  const o = createOfficeServer({ root, pollMs: 100, ...opts });
  await new Promise((r) => o.server.listen(0, '127.0.0.1', r));
  t.after(() => o.close());
  return `http://127.0.0.1:${o.server.address().port}`;
}
// SSE 메시지 하나씩. 큰 메시지는 여러 조각으로 오므로 빈 줄까지 모은다
function sseReader(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  return async () => {
    while (!buf.includes('\n\n')) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buf += dec.decode(value, { stream: true });
    }
    const i = buf.indexOf('\n\n');
    const msg = buf.slice(0, i);
    buf = buf.slice(i + 2);
    return JSON.parse(msg.replace(/^data: /, ''));
  };
}
let u = 0;
const at = (s) => new Date(Date.UTC(2026, 9, 23, 1, 0, s)).toISOString();
const rec = (o) => `${JSON.stringify({ uuid: `u${u++}`, ...o })}\n`;
const tool = (sec, id, name, input) => rec({ type: 'assistant', timestamp: at(sec), requestId: `r${u}`, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (sec, id, content) => rec({ type: 'user', timestamp: at(sec), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const human = (sec, text) => rec({ type: 'user', timestamp: at(sec), message: { role: 'user', content: text } });

function session(t, lines) {
  const root = tmp(t);
  fs.mkdirSync(path.join(root, 'C--p'));
  const file = path.join(root, 'C--p', 's1.jsonl');
  fs.writeFileSync(file, lines);
  return { root, file };
}

test('/sessions: 목록과 found, 기록 폴더가 없으면 found:false', async (t) => {
  const { root } = session(t, human(0, '안녕'));
  const d = await (await fetch(`${await start(t, root)}/sessions`)).json();
  assert.equal(d.found, true);
  assert.deepEqual(d.sessions.map((s) => [s.id, s.title, s.live]), [['C--p/s1', '안녕', true]]);
  const d2 = await (await fetch(`${await start(t, path.join(root, 'nope'))}/sessions`)).json();
  assert.equal(d2.found, false);
  assert.deepEqual(d2.sessions, []);
});

test('/stream: 첫 메시지에 전부, 줄이 붙으면 결과가 온 단계·새 단계만', async (t) => {
  const { root, file } = session(t, human(0, '해줘') + `${JSON.stringify({ type: 'ai-title', aiTitle: '제목' })}\n` + tool(1, 't1', 'Edit', { file_path: 'a.js' }));
  const base = await start(t, root, { contextLimit: 1000 });
  const ac = new AbortController();
  t.after(() => ac.abort());
  const res = await fetch(`${base}/stream?session=C--p/s1`, { signal: ac.signal });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const next = sseReader(res);
  const first = await next();
  assert.equal(first.session, 'C--p/s1');
  assert.equal(first.title, '제목');
  assert.equal(first.contextLimit, 1000);
  assert.equal(first.gone, false);
  assert.deepEqual(first.steps.map((s) => s.kind), ['user', 'tool']);
  assert.deepEqual(first.agents, []);
  fs.appendFileSync(file, result(2, 't1', 'ok') + tool(3, 't2', 'Bash', { command: 'npm test' }));
  const msg = await next();
  assert.deepEqual(msg.steps.map((s) => [s.id, s.end !== null]), [[first.steps[1].id, true], ['main:2', false]]);
});

test('/step: 입력·결과(20KB에서 자름), 없는 단계·세션은 404', async (t) => {
  const { root } = session(t, tool(0, 't1', 'Bash', { command: 'cat big' }) + result(1, 't1', 'z'.repeat(50000)));
  const base = await start(t, root);
  const d = await (await fetch(`${base}/step?session=C--p/s1&step=main:0`)).json();
  assert.equal(d.step.tool, 'Bash');
  assert.match(d.input.text, /cat big/);
  assert.equal(d.result.text.length, 20 * 1024);
  assert.equal(d.result.truncated, true);
  assert.equal((await fetch(`${base}/step?session=C--p/s1&step=main:99`)).status, 404);
  assert.equal((await fetch(`${base}/step?session=C--p/nope&step=main:0`)).status, 404);
});

test('세션 값이 이상하면 404(기록 폴더 밖으로 못 나간다)', async (t) => {
  const { root } = session(t, human(0, '안녕'));
  fs.writeFileSync(path.join(root, 'secret.jsonl'), human(0, '비밀'));
  const base = await start(t, root);
  for (const q of ['session=..%2Fsecret', 'session=C--p%2F..%2F..%2Fsecret', 'session=', '', 'session=C--p/nope', 'session=C--p/..'])
    assert.equal((await fetch(`${base}/stream?${q}`)).status, 404, q);
});

test('화면 파일은 public 안의 알려진 종류만, GET만', async (t) => {
  const { root } = session(t, human(0, '안녕'));
  const pub = tmp(t);
  fs.writeFileSync(path.join(pub, 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(pub, 'a.exe'), 'x');
  const base = await start(t, root, { publicDir: pub });
  const ok = await fetch(`${base}/`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /text\/html/);
  for (const p of ['/a.exe', '/nope.html', '/%2e%2e/package.json', '/..%2fserver%2fserver.js'])
    assert.equal((await fetch(base + p)).status, 404, p);
  assert.equal((await fetch(`${base}/sessions`, { method: 'POST' })).status, 404);
});

test('서버는 이 PC(127.0.0.1)에서만 접속을 받는다', async (t) => {
  const { spawn } = require('node:child_process');
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal);
  if (!lan) return t.skip('외부 네트워크 주소가 없음');
  const port = 7890 + Math.floor(Math.random() * 100);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(port), CLAUDE_PROJECTS: tmp(t) },
  });
  t.after(() => child.kill());
  await new Promise((r) => child.stdout.once('data', r));
  assert.equal((await fetch(`http://127.0.0.1:${port}/sessions`)).status, 200);
  await assert.rejects(fetch(`http://${lan.address}:${port}/sessions`));
});
```

- [ ] **Step 2: 실패 확인**

Run: `fnm exec --using=22 node --test test/server.test.js`
Expected: FAIL — `Cannot find module '../server/server'`

- [ ] **Step 3: 구현**

`server/server.js`:
```js
// claude-office 서버: 세션 목록, 세션 단계 SSE, 단계 상세, 화면 파일. ~/.claude는 읽기만 한다.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listSessions, resolveSession } = require('./sessions');
const { createReader } = require('./tail');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body = '', type = 'text/plain; charset=utf-8') {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
const sse = (msg) => `data: ${JSON.stringify(msg)}\n\n`;

function createOfficeServer({
  root = path.join(os.homedir(), '.claude', 'projects'),
  contextLimit = 200000,
  pollMs = 1000,
  publicDir = path.join(__dirname, '..', 'public'),
} = {}) {
  const open = new Map(); // 파일 → { reader, clients, gone } (보는 화면이 있는 세션만)

  // 늘어난 줄을 읽어 그 세션을 보는 화면들에 보낸다
  function tick(entry) {
    const { steps, agents, gone } = entry.reader.poll();
    if (gone) {
      if (!entry.gone) {
        entry.gone = true;
        for (const c of entry.clients) c.write(sse({ gone: true }));
      }
      return;
    }
    if (steps.length || agents.length) {
      const msg = sse({ steps, agents });
      for (const c of entry.clients) c.write(msg);
    }
  }

  function stream(res, query) {
    const id = query.get('session');
    const file = resolveSession(root, id);
    if (!file) return send(res, 404, 'not found');
    let entry = open.get(file);
    if (!entry) {
      entry = { reader: createReader(file), clients: new Set(), gone: false };
      open.set(file, entry);
    }
    tick(entry); // 이미 보던 화면들에 밀린 것부터 보내고, 새 화면에는 전부
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const all = entry.reader.all();
    res.write(sse({ session: id, title: entry.reader.title, contextLimit, steps: all.steps, agents: all.agents, gone: entry.gone }));
    entry.clients.add(res);
    res.on('close', () => {
      entry.clients.delete(res);
      if (entry.clients.size === 0 && open.get(file) === entry) open.delete(file);
    });
  }

  function step(res, query) {
    const file = resolveSession(root, query.get('session'));
    if (!file) return send(res, 404, 'not found');
    let reader = open.get(file)?.reader;
    if (!reader) {
      reader = createReader(file);
      reader.poll();
    }
    const d = reader.detail(query.get('step') ?? '');
    return d ? json(res, 200, d) : send(res, 404, 'not found');
  }

  function serveFile(pathname, res) {
    const file = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);
    const type = TYPES[path.extname(file)];
    if (!file.startsWith(publicDir + path.sep) || !type) return send(res, 404, 'not found');
    fs.readFile(file, (err, data) => (err ? send(res, 404, 'not found') : send(res, 200, data, type)));
  }

  const server = http.createServer((req, res) => {
    let pathname, query;
    try {
      ({ pathname, searchParams: query } = new URL(req.url, 'http://x'));
    } catch {
      return send(res, 400, 'bad url');
    }
    if (req.method !== 'GET') return send(res, 404, 'not found');
    if (pathname === '/sessions') {
      const sessions = listSessions(root);
      return json(res, 200, { root, found: sessions !== null, sessions: sessions ?? [] });
    }
    if (pathname === '/stream') return stream(res, query);
    if (pathname === '/step') return step(res, query);
    serveFile(pathname, res);
  });

  const timer = setInterval(() => {
    for (const entry of open.values()) tick(entry);
  }, pollMs);
  timer.unref();

  return {
    server,
    close() {
      clearInterval(timer);
      for (const entry of open.values()) for (const c of entry.clients) c.end();
      server.closeAllConnections();
      server.close();
    },
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 7800;
  const opts = {};
  if (process.env.CLAUDE_PROJECTS) opts.root = process.env.CLAUDE_PROJECTS;
  if (Number(process.env.CONTEXT_LIMIT) > 0) opts.contextLimit = Number(process.env.CONTEXT_LIMIT);
  // 기록에 코드·경로·명령 결과가 그대로 있으므로 이 PC에서만 연다
  createOfficeServer(opts).server.listen(port, '127.0.0.1', () => console.log(`claude-office: http://localhost:${port}`));
}

module.exports = { createOfficeServer };
```

- [ ] **Step 4: 통과 확인**

Run: `fnm exec --using=22 npm.cmd test`
Expected: PASS (parse 7 + tail 7 + sessions 2 + server 6 = 22)

- [ ] **Step 5: 커밋**

```bash
git add server/server.js test/server.test.js
git commit -m "feat(server): /sessions·/stream(SSE)·/step·화면 파일, 127.0.0.1만"
```

---

### Task 5: 장면 계산(scene)

**Files:**
- Create: `public/scene.mjs`
- Test: `test/scene.test.mjs`

**Interfaces:**
- Consumes: Step·Agent 모양(Task 1·2).
- Produces:
  - `timeline(steps, gap = 5000, keep = 1000)` → `{ start, end, total, toV(t), toT(v) }`
  - `sceneAt(steps (t 순), agents, clock, contextLimit = 200000)` → `{ staff: Actor, interns: (Actor & { id, role })[], counts: {place: n}, active: place[], ctx: { used, limit }, feed: Step[] }`
    - `Actor = { place, bubble, busy, err }`
  - `bubbleOf(step)` → string, `markers(steps, agents)` → `{ t, kind: 'user'|'err'|'intern' }[]`, `fmtDur(ms)` → string, `ICONS`.

- [ ] **Step 1: 실패하는 테스트**

`test/scene.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { bubbleOf, fmtDur, markers, sceneAt, timeline } from '../public/scene.mjs';

test('timeline: 5초 넘는 빈 시간은 1초로, 왕복 변환, 끝 뒤는 그대로, 빈 목록', () => {
  const tl = timeline([{ t: 0 }, { t: 1000, end: 2000 }, { t: 60000, end: 61000 }]);
  assert.equal(tl.start, 0);
  assert.equal(tl.end, 61000);
  assert.equal(tl.total, 4000); // 1 + 1 + (58→1) + 1초
  assert.equal(tl.toV(1500), 1500);
  assert.equal(tl.toV(31000), 2500);
  assert.equal(tl.toT(2500), 31000);
  assert.equal(tl.toV(-5), 0);
  assert.equal(tl.toT(0), 0);
  assert.equal(tl.toV(62000), 5000);
  assert.equal(Math.round(tl.toT(tl.toV(45678))), 45678);
  const e = timeline([]);
  assert.equal(e.total, 0);
  assert.equal(e.toV(5), 0);
});

const T0 = 1_000_000;
const st = (o) => ({ who: 'main', end: null, ok: null, ...o });
const steps = [
  st({ id: 'main:0', kind: 'user', t: T0, place: 'meeting', summary: '해줘' }),
  st({ id: 'main:1', kind: 'think', t: T0 + 1000, thinkMs: 2400, thinkText: null, tokens: { in: 10, out: 5, cache: 990 } }),
  st({ id: 'main:2', kind: 'tool', t: T0 + 3000, tool: 'Edit', place: 'desk', summary: 'a.js', end: T0 + 4000, ok: true }),
  st({ id: 'main:3', kind: 'tool', t: T0 + 5000, tool: 'Bash', place: 'server', summary: 'npm test', end: T0 + 9000, ok: false }),
  st({ id: 'main:4', kind: 'tool', t: T0 + 6000, tool: 'Agent', place: 'intern', summary: 'review', end: T0 + 6100, ok: true }),
  { id: 'ag:0', who: 'ag', kind: 'tool', t: T0 + 7000, tool: 'Read', place: 'shelf', summary: 'app.mjs', end: T0 + 8000, ok: true },
];
const agents = [{ id: 'ag', role: '리뷰', start: T0 + 7000, end: T0 + 8000 }];

test('sceneAt: 직원 자리·말풍선·바쁨, 방 횟수, 문맥', () => {
  let s = sceneAt(steps, agents, T0 - 1, 4000);
  assert.deepEqual(s.staff, { place: 'desk', bubble: null, busy: false, err: false });
  assert.deepEqual(s.counts, {});
  assert.deepEqual(s.interns, []);
  assert.deepEqual(s.ctx, { used: 0, limit: 4000 });

  s = sceneAt(steps, agents, T0 + 1500, 4000);
  assert.equal(s.staff.place, 'meeting'); // 생각은 자리를 안 옮긴다
  assert.equal(s.staff.bubble, '💭 생각 2초');
  assert.deepEqual(s.ctx, { used: 1000, limit: 4000 });

  s = sceneAt(steps, agents, T0 + 3500, 4000);
  assert.deepEqual(s.staff, { place: 'desk', bubble: '✏️ a.js', busy: true, err: false });
  assert.deepEqual(s.active, ['desk']);
  assert.equal(s.feed.length, 3);

  s = sceneAt(steps, agents, T0 + 5500, 4000);
  assert.equal(s.staff.place, 'server');
  assert.equal(s.staff.busy, true);
});

test('sceneAt: 인턴 등장·일·회의실 보고·퇴장, 실패 ❗는 2초', () => {
  let s = sceneAt(steps, agents, T0 + 7500);
  assert.equal(s.staff.place, 'intern');
  assert.equal(s.staff.busy, false);
  assert.deepEqual(s.interns, [{ id: 'ag', role: '리뷰', place: 'shelf', bubble: '📚 app.mjs', busy: true, err: false }]);
  assert.deepEqual(s.counts, { meeting: 1, desk: 1, server: 1, intern: 1, shelf: 1 });
  assert.deepEqual(s.active, ['shelf']);

  s = sceneAt(steps, agents, T0 + 8500);
  assert.equal(s.interns[0].place, 'meeting');
  assert.equal(s.interns[0].bubble, '📋 리뷰 보고');
  assert.equal(s.staff.err, false);

  s = sceneAt(steps, agents, T0 + 9500);
  assert.equal(s.staff.err, true);
  assert.deepEqual(s.interns, []);

  s = sceneAt(steps, agents, T0 + 11500);
  assert.equal(s.staff.err, false);

  const still = sceneAt(steps, [{ ...agents[0], end: null }], T0 + 60000);
  assert.equal(still.interns.length, 1); // 아직 일하는 인턴은 남는다
});

test('bubbleOf·markers·fmtDur', () => {
  assert.equal(bubbleOf({ kind: 'think', thinkText: ':has 중첩 불가', thinkMs: 9000 }), '💭 :has 중첩 불가');
  assert.equal(bubbleOf({ kind: 'think', thinkText: null, thinkMs: null }), '💭 생각 중');
  assert.equal(bubbleOf({ kind: 'compact' }), '📦 정리');
  assert.equal(bubbleOf({ kind: 'user', summary: '해줘' }), '💬 해줘');
  assert.equal(bubbleOf({ kind: 'answer', summary: '끝' }), '📝 끝');
  assert.equal(bubbleOf({ kind: 'tool', place: 'server', summary: '', tool: 'Bash' }), '▶ Bash');
  assert.deepEqual(markers(steps, agents), [
    { t: T0, kind: 'user' },
    { t: T0 + 7000, kind: 'intern' },
    { t: T0 + 9000, kind: 'err' },
  ]);
  assert.equal(fmtDur(420), '0.4초');
  assert.equal(fmtDur(9500), '9.5초');
  assert.equal(fmtDur(42000), '42초');
  assert.equal(fmtDur(64000), '1분 4초');
});
```

- [ ] **Step 2: 실패 확인**

Run: `fnm exec --using=22 node --test test/scene.test.mjs`
Expected: FAIL — `Cannot find module` `../public/scene.mjs`

- [ ] **Step 3: 구현**

`public/scene.mjs`:
```js
// 단계 목록 + 시계 → 그 순간의 장면(누가 어느 방에, 말풍선, 방 횟수). 화면과 떨어진 순수 함수.

export const GAP_MS = 5000;   // 이보다 긴 빈 시간은
export const KEEP_MS = 1000;  // 이만큼으로 줄여 재생한다
export const ERR_MS = 2000;   // 실패 ❗를 띄우는 시간
export const LEAVE_MS = 1500; // 인턴이 일을 마치고 회의실에 들러 있는 시간

export const ICONS = { shelf: '📚', desk: '✏️', server: '▶', search: '🔍', window: '🪟', manual: '📘', meeting: '💬', intern: '🧑‍🎓', misc: '📦' };

// 정렬된 arr에서 arr[i] <= x인 마지막 i(범위 밖이면 양 끝)
function seg(arr, x) {
  let lo = 0;
  let hi = arr.length - 1;
  if (x <= arr[0]) return 0;
  if (x >= arr[hi]) return hi;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (arr[m] <= x) lo = m;
    else hi = m;
  }
  return lo;
}

// 실제 시각(t) ↔ 재생 시각(v). 긴 빈 시간은 keep으로 눌러 담는다. 끝 뒤는 그대로 흐른다(실시간)
export function timeline(steps, gap = GAP_MS, keep = KEEP_MS) {
  const ts = [...new Set(steps.flatMap((s) => (s.end != null ? [s.t, s.end] : [s.t])))].sort((a, b) => a - b);
  if (ts.length === 0) return { start: 0, end: 0, total: 0, toV: () => 0, toT: () => 0 };
  const vs = [0];
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i] - ts[i - 1];
    vs.push(vs[i - 1] + (d > gap ? keep : d));
  }
  const last = ts.length - 1;
  const toV = (t) => {
    if (t <= ts[0]) return 0;
    const i = seg(ts, t);
    if (i === last) return vs[i] + (t - ts[i]);
    return vs[i] + ((t - ts[i]) * (vs[i + 1] - vs[i])) / (ts[i + 1] - ts[i]);
  };
  const toT = (v) => {
    if (v <= 0) return ts[0];
    const i = seg(vs, v);
    if (i === last) return ts[i] + (v - vs[i]);
    return ts[i] + ((v - vs[i]) * (ts[i + 1] - ts[i])) / (vs[i + 1] - vs[i]);
  };
  return { start: ts[0], end: ts[last], total: vs[last], toV, toT };
}

export function bubbleOf(s) {
  if (s.kind === 'think') return `💭 ${s.thinkText ?? (s.thinkMs != null ? `생각 ${Math.max(1, Math.round(s.thinkMs / 1000))}초` : '생각 중')}`;
  if (s.kind === 'compact') return '📦 정리';
  if (s.kind === 'user') return `💬 ${s.summary}`;
  if (s.kind === 'answer') return `📝 ${s.summary}`;
  return `${ICONS[s.place] ?? '📦'} ${s.summary || s.tool}`;
}

export function fmtDur(ms) {
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}초`;
  const sec = Math.round(ms / 1000);
  return `${Math.floor(sec / 60)}분 ${sec % 60}초`;
}

// clock(실제 시각 ms) 순간의 장면. steps는 t 순
export function sceneAt(steps, agents, clock, contextLimit = 200000) {
  const feed = [];
  const counts = {};
  const actors = new Map(); // who → { place, bubble, busy, err }
  const errs = new Set();
  let used = 0;
  for (const s of steps) {
    if (s.t > clock) break;
    feed.push(s);
    const a = actors.get(s.who) ?? { place: s.who === 'main' ? 'desk' : 'intern', bubble: null, busy: false, err: false };
    if (s.place) {
      a.place = s.place;
      counts[s.place] = (counts[s.place] ?? 0) + 1;
    }
    a.bubble = bubbleOf(s);
    a.busy = s.kind === 'tool' && (s.end == null || s.end > clock);
    actors.set(s.who, a);
    if (s.kind === 'tool' && s.ok === false && s.end <= clock && clock < s.end + ERR_MS) errs.add(s.who);
    if (s.who === 'main' && s.tokens) used = s.tokens.in + s.tokens.cache;
    if (s.who === 'main' && s.kind === 'compact') used = 0;
  }
  const staff = { ...(actors.get('main') ?? { place: 'desk', bubble: null, busy: false, err: false }), err: errs.has('main') };
  const interns = [];
  for (const ag of agents) {
    if (ag.start == null || clock < ag.start) continue;
    if (ag.end != null && clock >= ag.end + LEAVE_MS) continue;
    const a = actors.get(ag.id) ?? { place: 'intern', bubble: null, busy: false, err: false };
    const leaving = ag.end != null && clock >= ag.end;
    interns.push({
      id: ag.id,
      role: ag.role,
      place: leaving ? 'meeting' : a.place,
      bubble: leaving ? `📋 ${ag.role} 보고` : a.bubble,
      busy: leaving ? false : a.busy,
      err: errs.has(ag.id),
    });
  }
  const active = [...new Set([staff, ...interns].filter((a) => a.busy).map((a) => a.place))];
  return { staff, interns, counts, active, ctx: { used, limit: contextLimit }, feed };
}

// 재생 띠 위 표시: 사용자 요청·실패·인턴 출발
export function markers(steps, agents) {
  const out = [];
  for (const s of steps) {
    if (s.kind === 'user') out.push({ t: s.t, kind: 'user' });
    else if (s.kind === 'tool' && s.ok === false && s.end != null) out.push({ t: s.end, kind: 'err' });
  }
  for (const a of agents) if (a.start != null) out.push({ t: a.start, kind: 'intern' });
  return out.sort((a, b) => a.t - b.t);
}
```

- [ ] **Step 4: 통과 확인**

Run: `fnm exec --using=22 node --test test/scene.test.mjs`
Expected: PASS 4/4

- [ ] **Step 5: 커밋**

```bash
git add public/scene.mjs test/scene.test.mjs
git commit -m "feat(public): 장면 계산(빈 시간 줄이기·자리·말풍선·인턴·띠 표시)"
```

---

### Task 6: 사무실 그림(art)과 Kenney 시트

**Files:**
- Create: `public/art.mjs`, `public/art/indoor.png`, `public/art/chars.png`, `public/art/LICENSE-kenney.txt`
- Test: `test/art.test.mjs`

**Interfaces:**
- Produces: `S = 3`, `TILE = 16`, `ROOM_W = 6`, `ROOM_H = 4`, `WALL = 1`, `LAYOUT` (3×3 place), `ROOMS` (`{ [place]: { name, tools, floor: [c,r] | '#색', items: [c, r, tx, ty][], monitors?: [tx, ty][] } }`), `OFFICE_W = 1056`, `OFFICE_H = 768`, `CHAR`, `roomRect(place)` → `{x,y,w,h}` | null, `spot(place, i)` → `{x,y}`, `drawOffice(ctx, sheet)`, `charLayers(kind)` → CSS background 문자열[].

- [ ] **Step 1: 시트 복사**

Kenney 팩은 이미 받아 확인했다(`C:\Users\jjshs\AppData\Local\Temp\claude\C--\a9d50998-9a54-4325-9272-01fb9ae5fce8\scratchpad\kenney-dl`). 투명 시트와 라이선스만 옮긴다:
```bash
K="C:/Users/jjshs/AppData/Local/Temp/claude/C--/a9d50998-9a54-4325-9272-01fb9ae5fce8/scratchpad/kenney-dl"
mkdir -p public/art
cp "$K/indoors/Tilesheets/roguelikeIndoor_transparent.png" public/art/indoor.png
cp "$K/chars/Spritesheet/roguelikeChar_transparent.png" public/art/chars.png
{ cat "$K/indoors/License.txt"; echo; cat "$K/chars/License.txt"; } > public/art/LICENSE-kenney.txt
```
Expected: `indoor.png` 458×305, `chars.png` 918×203.

- [ ] **Step 2: 실패하는 테스트**

`test/art.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAR, LAYOUT, OFFICE_H, OFFICE_W, ROOMS, ROOM_H, ROOM_W, S, TILE, charLayers, roomRect, spot } from '../public/art.mjs';

const PLACES = ['desk', 'intern', 'manual', 'meeting', 'misc', 'search', 'server', 'shelf', 'window'];

test('방 9개가 3×3에 하나씩, 사무실 안, 서로 겹치지 않음', () => {
  assert.deepEqual(LAYOUT.flat().sort(), PLACES);
  assert.deepEqual(Object.keys(ROOMS).sort(), PLACES);
  assert.equal(OFFICE_W, 1056);
  assert.equal(OFFICE_H, 768);
  const rects = PLACES.map(roomRect);
  for (const r of rects) assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= OFFICE_W && r.y + r.h <= OFFICE_H);
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const [a, b] = [rects[i], rects[j]];
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
    }
  assert.equal(roomRect('nope'), null);
});

test('spot: 캐릭터(48px)가 방 안에, 0~5번째는 서로 다른 자리, 모르는 자리는 기타 방', () => {
  const U = TILE * S;
  for (const p of PLACES) {
    const r = roomRect(p);
    const seen = new Set();
    for (let i = 0; i < 6; i++) {
      const s = spot(p, i);
      assert.ok(s.x >= r.x && s.y >= r.y && s.x + U <= r.x + r.w && s.y + U <= r.y + r.h, `${p} ${i}`);
      seen.add(`${s.x},${s.y}`);
    }
    assert.equal(seen.size, 6);
  }
  assert.deepEqual(spot('nope', 0), spot('misc', 0));
});

test('그림 칸 좌표는 시트 안(실내 27×18, 캐릭터 54×12), 가구는 방 안', () => {
  for (const room of Object.values(ROOMS)) {
    if (Array.isArray(room.floor)) assert.ok(room.floor[0] < 27 && room.floor[1] < 18);
    for (const [c, r, tx, ty] of room.items) assert.ok(c < 27 && r < 18 && tx < ROOM_W && ty < ROOM_H, `${c},${r} @ ${tx},${ty}`);
    for (const [tx, ty] of room.monitors ?? []) assert.ok(tx < ROOM_W && ty < ROOM_H);
    assert.ok(room.name && room.tools);
  }
  for (const layers of Object.values(CHAR)) for (const [c, r] of layers) assert.ok(c < 54 && r < 12);
  const bg = charLayers('staff');
  assert.equal(bg.length, 4);
  assert.match(bg[0], /^url\(art\/chars\.png\) -0px -0px \/ 2754px 609px no-repeat$/);
  assert.deepEqual(charLayers('nope'), bg);
});
```

- [ ] **Step 3: 실패 확인**

Run: `fnm exec --using=22 node --test test/art.test.mjs`
Expected: FAIL — `Cannot find module` `../public/art.mjs`

- [ ] **Step 4: 구현**

`public/art.mjs`:
```js
// 사무실 그림: Kenney CC0 시트(16×16, 1px 간격)에서 칸을 잘라 그린다. 그림을 바꾸려면 이 파일만 고친다.

export const S = 3;       // 확대 배율
export const TILE = 16;   // 칸 크기(px)
const STEP = 17;          // 시트에서 칸 간격(16 + 1px)
const U = TILE * S;       // 화면에서 칸 크기
export const ROOM_W = 6;  // 방 크기(칸)
export const ROOM_H = 4;
export const WALL = 1;    // 벽 두께(칸)

export const LAYOUT = [
  ['shelf', 'desk', 'server'],
  ['search', 'meeting', 'window'],
  ['manual', 'intern', 'misc'],
];
export const OFFICE_W = (3 * ROOM_W + 4 * WALL) * U;
export const OFFICE_H = (3 * ROOM_H + 4 * WALL) * U;

const WOOD = [24, 1];   // 나무 바닥
const CARPET = [24, 5]; // 초록 카펫

// items: [시트 열, 시트 행, 방 안 x칸, 방 안 y칸]. 앞에 있을수록 먼저(아래에) 그린다
export const ROOMS = {
  shelf: { name: '서가', tools: 'Read', floor: WOOD, items: [[19, 17, 0, 0], [20, 17, 1, 0], [21, 17, 2, 0], [19, 17, 3, 0], [20, 17, 4, 0], [16, 0, 5, 0]] },
  desk: { name: '내 책상', tools: 'Edit · Write', floor: WOOD, items: [[7, 4, 2, 1], [7, 4, 3, 1], [0, 2, 2, 2], [17, 0, 5, 0]], monitors: [[2, 1]] },
  server: { name: '서버실', tools: 'Bash', floor: '#3a3f4b', items: [[25, 8, 0, 0], [25, 9, 0, 1], [26, 8, 1, 0], [26, 9, 1, 1], [25, 8, 4, 0], [25, 9, 4, 1], [26, 8, 5, 0], [26, 9, 5, 1]] },
  search: { name: '찾기 책상', tools: 'Grep · Glob', floor: WOOD, items: [[7, 4, 2, 1], [18, 0, 2, 1], [0, 2, 2, 2]] },
  meeting: { name: '회의실', tools: '사용자', floor: CARPET, items: [[7, 9, 1, 1], [8, 9, 2, 1], [9, 9, 3, 1], [1, 2, 1, 0], [1, 2, 3, 0], [0, 2, 1, 2], [0, 2, 3, 2]] },
  window: { name: '창문', tools: 'Web', floor: WOOD, items: [[22, 14, 1, 0], [22, 15, 1, 1], [22, 14, 4, 0], [22, 15, 4, 1], [16, 0, 0, 0], [17, 0, 5, 0]] },
  manual: { name: '매뉴얼 선반', tools: '스킬', floor: WOOD, items: [[20, 12, 1, 0], [21, 12, 2, 0], [0, 13, 4, 0], [1, 13, 5, 0]] },
  intern: { name: '인턴 자리', tools: 'Agent', floor: WOOD, items: [[7, 4, 1, 1], [7, 4, 4, 1], [0, 2, 1, 2], [0, 2, 4, 2]], monitors: [[1, 1], [4, 1]] },
  misc: { name: '기타', tools: 'MCP 등', floor: WOOD, items: [[12, 15, 1, 1], [13, 15, 2, 1], [16, 3, 4, 2]] },
};

// 캐릭터: 몸·바지·셔츠·머리 칸을 겹친다(Roguelike Characters 시트)
const CHAR_SHEET = { w: 918, h: 203 };
export const CHAR = {
  staff: [[0, 0], [3, 0], [6, 0], [19, 0]],   // 주황 셔츠 = 클로드
  intern: [[0, 1], [3, 1], [14, 0], [21, 0]], // 보라 셔츠 = 인턴
};

export function roomRect(place) {
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      if (LAYOUT[r][c] === place) return { x: (WALL + c * (ROOM_W + WALL)) * U, y: (WALL + r * (ROOM_H + WALL)) * U, w: ROOM_W * U, h: ROOM_H * U };
  return null;
}

// i번째 사람이 서는 자리(왼쪽 위 px). 한 방에 여럿이면 옆으로, 셋 넘으면 뒤로
export function spot(place, i = 0) {
  const r = roomRect(place) ?? roomRect('misc');
  return { x: r.x + 2 * U + (i % 3) * Math.round(U * 0.8), y: r.y + 2 * U - Math.floor(i / 3) * Math.round(U / 2) };
}

function tile(ctx, sheet, c, r, x, y) {
  ctx.drawImage(sheet, c * STEP, r * STEP, TILE, TILE, x, y, U, U);
}

// 팩에 없는 모니터는 픽셀로 직접
function monitor(ctx, x, y) {
  const p = S;
  ctx.fillStyle = '#1f2937';
  ctx.fillRect(x + 3 * p, y + 1 * p, 10 * p, 8 * p);
  ctx.fillStyle = '#4ea1ff';
  ctx.fillRect(x + 4 * p, y + 2 * p, 8 * p, 6 * p);
  ctx.fillStyle = '#1f2937';
  ctx.fillRect(x + 7 * p, y + 9 * p, 2 * p, 2 * p);
  ctx.fillRect(x + 5 * p, y + 11 * p, 6 * p, 1 * p);
}

export function drawOffice(ctx, sheet) {
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#5b4a3a'; // 벽
  ctx.fillRect(0, 0, OFFICE_W, OFFICE_H);
  for (const [place, room] of Object.entries(ROOMS)) {
    const { x, y } = roomRect(place);
    for (let ty = 0; ty < ROOM_H; ty++)
      for (let tx = 0; tx < ROOM_W; tx++) {
        if (typeof room.floor === 'string') {
          ctx.fillStyle = room.floor;
          ctx.fillRect(x + tx * U, y + ty * U, U, U);
          ctx.strokeStyle = '#00000040';
          ctx.strokeRect(x + tx * U + 0.5, y + ty * U + 0.5, U - 1, U - 1);
        } else tile(ctx, sheet, room.floor[0], room.floor[1], x + tx * U, y + ty * U);
      }
    for (const [c, r, tx, ty] of room.items) tile(ctx, sheet, c, r, x + tx * U, y + ty * U);
    for (const [tx, ty] of room.monitors ?? []) monitor(ctx, x + tx * U, y + ty * U);
  }
}

export function charLayers(kind) {
  return (CHAR[kind] ?? CHAR.staff).map(
    ([c, r]) => `url(art/chars.png) -${c * STEP * S}px -${r * STEP * S}px / ${CHAR_SHEET.w * S}px ${CHAR_SHEET.h * S}px no-repeat`,
  );
}
```

- [ ] **Step 5: 통과 확인**

Run: `fnm exec --using=22 node --test test/art.test.mjs`
Expected: PASS 3/3

- [ ] **Step 6: 커밋**

```bash
git add public/art.mjs public/art test/art.test.mjs
git commit -m "feat(public): Kenney CC0 시트로 사무실 9개 방·캐릭터 그리기"
```

---

### Task 7: 화면(index.html·app.mjs)과 브라우저 확인

**Files:**
- Create: `public/index.html`, `public/app.mjs`, `README.md`
- 확인 스크립트(커밋 안 함): `C:\Users\jjshs\AppData\Local\Temp\claude\C--\a9d50998-9a54-4325-9272-01fb9ae5fce8\scratchpad\office-check.cjs`

**Interfaces:**
- Consumes: `/sessions`, `/stream`, `/step` (Task 4); `timeline`, `sceneAt`, `bubbleOf`, `markers`, `fmtDur` (Task 5); `OFFICE_W`, `OFFICE_H`, `ROOMS`, `roomRect`, `spot`, `drawOffice`, `charLayers` (Task 6).
- Produces: 주소 `?session=<id>`로 세션을 바로 연다. DOM: `#sessions`, `#office` 안 `.room-hit[data-place]`(`.room-count`), `.char.staff`·`.char.intern`(`.bubble`, `.bang`, `.gauge`), `#feed div`, `#detail`, `#back`, `#toggle`, `[data-speed]`, `#pos`, `#marks i`, `#live`, `#conn`, `#summary`.

- [ ] **Step 1: 실패하는 브라우저 확인 스크립트**

`office-check.cjs` (scratchpad):
```js
// 가짜 기록으로 화면 확인: 사무실 그림, 띠 끌기로 자리 이동, 실패 ❗, 인턴 등장·퇴장, 재생 끝, 상세, 실시간 덧붙이기, 기본 세션, 오류 없음
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('C:/Users/jjshs/atelier/node_modules/playwright');
const { createOfficeServer } = require('C:/Users/jjshs/claude-office/server/server');
const { createReader } = require('C:/Users/jjshs/claude-office/server/tail');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-ui-'));
const proj = path.join(root, 'C--demo');
fs.mkdirSync(proj);
let u = 0;
const T0 = Date.now() - 10 * 60 * 1000;
const at = (s) => new Date(T0 + s * 1000).toISOString();
const rec = (o) => `${JSON.stringify({ uuid: `u${u++}`, ...o })}\n`;
const usage = { input_tokens: 5, output_tokens: 50, cache_read_input_tokens: 60000, cache_creation_input_tokens: 0 };
const tool = (s, id, name, input, ts = at(s)) => rec({ type: 'assistant', timestamp: ts, requestId: `r${u}`, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }], usage } });
const result = (s, id, content, err = false) => rec({ type: 'user', timestamp: at(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: err }] } });
const human = (s, text, ts = at(s)) => rec({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const think = (s, ms) => rec({ type: 'assistant', timestamp: at(s), requestId: `r${u}`, thinkingDurationMs: ms, message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] } });
const say = (s, text) => rec({ type: 'assistant', timestamp: at(s), requestId: `r${u}`, message: { role: 'assistant', content: [{ type: 'text', text }] } });

// 지난 세션: 요청 → 생각 → 읽기 → 고치기 → 테스트 실패 → 인턴 리뷰 → 답변
const past = path.join(proj, 'past.jsonl');
fs.writeFileSync(past,
  human(0, '패널 켜고 끄기 해줘') + `${JSON.stringify({ type: 'ai-title', aiTitle: '데모: 패널 켜고 끄기' })}\n` +
  think(1, 3000) + tool(4, 'a', 'Read', { file_path: 'C:/x/app.mjs' }) + result(5, 'a', 'body') +
  tool(6, 'b', 'Edit', { file_path: 'C:/x/index.html' }) + result(8, 'b', 'ok') +
  tool(9, 'c', 'Bash', { command: 'npm test', description: '테스트 돌리기' }) + result(20, 'c', 'FAIL', true) +
  tool(21, 'd', 'Agent', { description: '리뷰' }) + result(21, 'd', 'launched') +
  say(40, '끝났습니다.'));
const sub = path.join(proj, 'past', 'subagents');
fs.mkdirSync(sub, { recursive: true });
fs.writeFileSync(path.join(sub, 'agent-r1.jsonl'), tool(22, 's', 'Grep', { pattern: ':has' }) + result(30, 's', 'x'));
fs.writeFileSync(path.join(sub, 'agent-r1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: '리뷰', toolUseId: 'd', finished: true }));
const old = new Date(Date.now() - 3600_000);
for (const f of [past, path.join(sub, 'agent-r1.jsonl'), path.join(sub, 'agent-r1.meta.json')]) fs.utimesSync(f, old, old);
// 진행 중 세션
const live = path.join(proj, 'live.jsonl');
fs.writeFileSync(live, human(0, '지금 하는 일', new Date().toISOString()));

(async () => {
  const { timeline } = await import('file:///C:/Users/jjshs/claude-office/public/scene.mjs');
  const r = createReader(past);
  r.poll();
  const tl = timeline(r.all().steps);
  const office = createOfficeServer({ root, pollMs: 500 });
  await new Promise((ok) => office.server.listen(7811, '127.0.0.1', ok));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1920, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const seek = async (sec) => {
    const val = Math.round((tl.toV(T0 + sec * 1000) / tl.total) * 1000);
    await page.$eval('#pos', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); }, val);
    await page.waitForTimeout(700);
  };
  const where = (sel) => page.evaluate(async (s) => {
    const { spot, LAYOUT } = await import('/art.mjs');
    const el = document.querySelector(s);
    if (!el || el.hidden) return null;
    const x = parseFloat(el.style.left), y = parseFloat(el.style.top);
    for (const p of LAYOUT.flat()) for (let i = 0; i < 6; i++) { const q = spot(p, i); if (q.x === x && q.y === y) return p; }
    return '?';
  }, sel);
  const text = (sel) => page.$eval(sel, (el) => el.textContent);

  // 1. 지난 세션: 처음에서 멈춤, 사무실이 그려짐
  await page.goto('http://127.0.0.1:7811/?session=C--demo/past');
  await page.waitForFunction(() => document.querySelectorAll('#feed div').length >= 1);
  const colors = await page.$eval('#room', (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const s = new Set(); for (let i = 0; i < d.length; i += 4 * 97) s.add(`${d[i]},${d[i + 1]},${d[i + 2]}`); return s.size; });
  assert.ok(colors > 20, `사무실이 그려짐(색 ${colors})`);
  assert.equal(await text('#toggle'), '▶');
  await page.screenshot({ path: path.join(__dirname, 'office-1.png') });

  // 2. 띠를 끌면 직원이 그 순간 자리로
  await seek(4.5);
  assert.equal(await where('.char.staff'), 'shelf');
  assert.match(await text('.char.staff .bubble'), /app\.mjs/);
  await seek(7);
  assert.equal(await where('.char.staff'), 'desk');
  await seek(15);
  assert.equal(await where('.char.staff'), 'server');
  assert.equal(await page.$eval('.room-hit[data-place=server]', (el) => el.classList.contains('active')), true);
  await seek(20.5);
  assert.equal(await page.$eval('.char.staff .bang', (el) => el.hidden), false, '실패 ❗');
  assert.equal(await text('.room-hit[data-place=server] .room-count'), '1');

  // 3. 인턴 등장 → 일 → 퇴장
  await seek(25);
  assert.equal(await where('.char.intern'), 'search');
  assert.match(await text('.char.intern .bubble'), /:has/);
  assert.ok((await page.$$('#feed .sub')).length >= 1);
  await page.screenshot({ path: path.join(__dirname, 'office-2.png') });
  await seek(35);
  assert.equal(await where('.char.intern'), null);
  assert.ok((await page.$$('#marks i')).length >= 3, '띠 표시');

  // 4. 처음부터 ×32 재생 → 끝에서 멈춤
  await seek(0);
  await page.click('[data-speed="32"]');
  await page.click('#toggle');
  await page.waitForTimeout(1500);
  assert.equal(await text('#toggle'), '▶');
  assert.equal(await page.$eval('#pos', (el) => el.value), '1000');

  // 5. 피드 줄 → 상세 → 돌아가기
  const row = await page.$('#feed div:has-text("테스트 돌리기")');
  await row.click();
  await page.waitForFunction(() => document.querySelector('#detail pre'));
  assert.match(await text('#detail'), /npm test/);
  assert.match(await text('#detail'), /실패/);
  await page.click('#back');
  assert.equal(await page.$eval('#feed', (el) => el.hidden), false);

  // 6. 진행 중 세션: 기본 선택, 실시간, 덧붙인 줄이 2초 안에
  await page.goto('http://127.0.0.1:7811/');
  await page.waitForFunction(() => document.querySelectorAll('#feed div').length >= 1);
  assert.equal(await page.$eval('#sessions', (el) => el.value), 'C--demo/live');
  assert.equal(await page.$eval('#conn', (el) => el.className), 'live');
  fs.appendFileSync(live, tool(0, 'L1', 'Edit', { file_path: 'C:/x/live-file.js' }, new Date().toISOString()));
  const t0 = Date.now();
  await page.waitForFunction(() => document.querySelector('#feed').textContent.includes('live-file.js'), null, { timeout: 2500 });
  console.log('실시간 반영', Date.now() - t0, 'ms');
  await page.waitForTimeout(700);
  assert.equal(await where('.char.staff'), 'desk');

  assert.deepEqual(errors, []);
  console.log('OK');
  await browser.close();
  office.close();
  fs.rmSync(root, { recursive: true, force: true });
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
```

- [ ] **Step 2: 실패 확인**

Run (Git Bash): `cd <scratchpad> && CHROMIUM_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" fnm exec --using=22 node office-check.cjs`
Expected: FAIL — `#feed div`를 기다리다 시간 초과(`public/index.html` 없음 → 404)

- [ ] **Step 3: index.html**

`public/index.html`:
```html
<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claude-office</title>
<style>
  :root { --bg: #0f1419; --panel: #182028; --line: #2a3440; --text: #d8dee6; --dim: #8593a3; --ok: #4ea1ff; --err: #ff5c5c; --warn: #ffcc4d; --good: #4ade80; --intern: #d8b4fe; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 12px 16px; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, sans-serif; }
  #top { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
  #top h1 { font-size: 16px; margin: 0; }
  select, button { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; font: inherit; }
  select { max-width: 520px; }
  button { cursor: pointer; }
  button.on { border-color: var(--ok); color: var(--ok); }
  #summary { color: var(--dim); font-size: 13px; }
  #conn { margin-left: auto; font-size: 13px; color: var(--warn); }
  #conn.live { color: var(--good); }
  #conn.replay { color: var(--dim); }
  #empty { color: var(--warn); margin: 0 0 10px; }
  #main { display: grid; grid-template-columns: auto minmax(280px, 1fr); gap: 12px; align-items: start; }
  #office { position: relative; overflow: hidden; border-radius: 8px; }
  #office canvas { display: block; image-rendering: pixelated; }
  .room-hit { position: absolute; cursor: pointer; border: 2px solid transparent; border-radius: 4px; }
  .room-hit:hover { border-color: #ffffff40; }
  .room-hit.active { border-color: var(--warn); box-shadow: 0 0 14px var(--warn) inset; }
  .room-label, .room-count { position: absolute; bottom: 4px; font-size: 12px; color: #fff; background: #0009; border-radius: 8px; padding: 0 6px; pointer-events: none; }
  .room-label { left: 6px; }
  .room-count { right: 6px; font-variant-numeric: tabular-nums; }
  .char { position: absolute; width: 48px; height: 48px; transition: left 0.5s, top 0.5s; pointer-events: none; z-index: 2; }
  .char[hidden] { display: none; }
  .char i { position: absolute; inset: 0; image-rendering: pixelated; }
  .char.moving i { animation: bob 0.25s steps(2) infinite; }
  @keyframes bob { 50% { transform: translateY(-4px); } }
  .bubble { position: absolute; bottom: 54px; left: 50%; transform: translateX(-50%); background: #f1f5f9; color: #111; border-radius: 8px; padding: 1px 8px; font-size: 12px; white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis; z-index: 3; }
  .bubble[hidden], .bang[hidden] { display: none; }
  .char.intern .bubble { background: #ede9fe; }
  .bang { position: absolute; top: -26px; right: -10px; font-size: 20px; }
  .gauge { position: absolute; top: -8px; left: 4px; width: 40px; height: 5px; background: #111; }
  .gauge i { position: static; display: block; height: 100%; background: var(--good); }
  aside { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; display: flex; flex-direction: column; min-width: 0; }
  aside h2 { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--dim); margin: 0; padding: 6px 12px; border-bottom: 1px solid var(--line); }
  #back { padding: 0 8px; font-size: 12px; }
  #feed, #detail { overflow: auto; flex: 1; font-size: 12px; }
  #feed[hidden], #detail[hidden], #back[hidden] { display: none; }
  #feed div { padding: 2px 12px; border-bottom: 1px solid #222b35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
  #feed div:hover { background: #22303c; }
  #feed .user { color: var(--ok); }
  #feed .sub { color: var(--intern); padding-left: 26px; }
  #feed .err { color: var(--err); }
  #detail { padding: 8px 12px; }
  #detail h3 { font-size: 12px; color: var(--dim); margin: 10px 0 4px; }
  #detail pre { white-space: pre-wrap; word-break: break-all; background: #0b0f13; padding: 8px; border-radius: 6px; margin: 0; }
  #play { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
  #clock { color: var(--dim); font-variant-numeric: tabular-nums; min-width: 64px; }
  #scrub { position: relative; flex: 1; }
  #scrub input { width: 100%; margin: 8px 0 0; display: block; }
  #marks { position: absolute; left: 0; right: 0; top: 0; height: 6px; pointer-events: none; }
  #marks i { position: absolute; width: 3px; height: 6px; }
  .m-user { background: var(--ok); }
  .m-err { background: var(--err); }
  .m-intern { background: var(--intern); }
  #note { color: var(--dim); font-size: 12px; margin: 8px 0 0; }
</style>
</head>
<body>
  <div id="top"><h1>🏢 claude-office</h1><select id="sessions"></select><span id="summary"></span><span id="conn"></span></div>
  <p id="empty" hidden></p>
  <div id="main">
    <div id="office"><canvas id="room"></canvas></div>
    <aside><h2><span id="sidetitle">활동</span><button id="back" hidden>← 활동</button></h2><div id="feed"></div><div id="detail" hidden></div></aside>
  </div>
  <div id="play">
    <button id="toggle">▶</button>
    <button data-speed="1">×1</button><button data-speed="8">×8</button><button data-speed="32">×32</button>
    <span id="clock"></span>
    <div id="scrub"><div id="marks"></div><input id="pos" type="range" min="0" max="1000" value="0"></div>
    <button id="live">● 실시간으로</button>
  </div>
  <p id="note">기록에 남은 과정(도구 호출·입력·결과·토큰·하위 에이전트)을 보여 줍니다. 모델 내부 계산은 아니며, 생각 내용은 대부분 기록에 남지 않아 시간만 보입니다. 문맥 막대는 추정입니다. 5초 넘는 빈 시간은 1초로 줄여 재생합니다. 그림: Kenney (CC0).</p>
  <script type="module" src="app.mjs"></script>
</body>
</html>
```

- [ ] **Step 4: app.mjs**

`public/app.mjs`:
```js
// 화면: 세션 고르기 → SSE로 단계 받기 → 시계에 맞춰 사무실·피드 그리기
import { OFFICE_H, OFFICE_W, ROOMS, charLayers, drawOffice, roomRect, spot } from './art.mjs';
import { bubbleOf, fmtDur, markers, sceneAt, timeline } from './scene.mjs';

const $ = (id) => document.getElementById(id);
const MAX_FEED = 300;  // ponytail: 피드는 최근 300줄만 그린다
const RENDER_MS = 100; // 장면은 0.1초마다(데이터가 바뀌면 바로)

let current = null;     // 보고 있는 세션 id
let es = null;
let steps = new Map();  // id → 단계
let agents = new Map(); // id → 인턴
let sorted = [];        // t 순 단계
let tl = timeline([]);
let contextLimit = 200000;
let gone = false;
let mode = 'pause';     // 'live' | 'play' | 'pause'
let speed = 8;
let v = 0;              // 재생 시각(빈 시간 줄인 것)
let dragging = false;
let version = 0;        // 받은 데이터가 바뀔 때마다 +1
let detailId = null;

const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8);
const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// ---- 사무실 ----

const canvas = $('room');
canvas.width = OFFICE_W;
canvas.height = OFFICE_H;
Object.assign($('office').style, { width: `${OFFICE_W}px`, height: `${OFFICE_H}px` });
const sheet = new Image();
sheet.onload = () => drawOffice(canvas.getContext('2d'), sheet);
sheet.src = 'art/indoor.png';

const rooms = {}; // place → { el, count }
for (const [place, room] of Object.entries(ROOMS)) {
  const r = roomRect(place);
  const el = document.createElement('div');
  el.className = 'room-hit';
  el.dataset.place = place;
  Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  const label = document.createElement('span');
  label.className = 'room-label';
  label.textContent = `${room.name} · ${room.tools}`;
  const count = document.createElement('span');
  count.className = 'room-count';
  count.textContent = '0';
  el.append(label, count);
  // 방을 누르면 지금까지 그 방에서 한 마지막 일의 상세
  el.onclick = () => {
    const last = sceneAt(sorted, [], clockNow()).feed.findLast((s) => s.place === place);
    if (last) showDetail(last.id);
  };
  $('office').append(el);
  rooms[place] = { el, count };
}

const chars = new Map(); // who → 캐릭터 요소
function charEl(who, kind) {
  let el = chars.get(who);
  if (el) return el;
  el = document.createElement('div');
  el.className = `char ${kind}`;
  for (const bg of charLayers(kind)) {
    const i = document.createElement('i');
    i.style.background = bg;
    el.append(i);
  }
  const bubble = document.createElement('span');
  bubble.className = 'bubble';
  const bang = document.createElement('span');
  bang.className = 'bang';
  bang.textContent = '❗';
  el.append(bubble, bang);
  if (kind === 'staff') {
    const gauge = document.createElement('span');
    gauge.className = 'gauge';
    gauge.append(document.createElement('i'));
    el.append(gauge);
  }
  $('office').append(el);
  chars.set(who, el);
  return el;
}

function put(el, where, i, bubble, err) {
  const p = spot(where, i);
  const left = `${p.x}px`;
  const top = `${p.y}px`;
  if (el.style.left !== left || el.style.top !== top) {
    el.classList.add('moving');
    clearTimeout(el.moveTimer);
    el.moveTimer = setTimeout(() => el.classList.remove('moving'), 500);
    el.style.left = left;
    el.style.top = top;
  }
  const b = el.querySelector('.bubble');
  if (b.textContent !== (bubble ?? '')) b.textContent = bubble ?? '';
  b.hidden = !bubble;
  el.querySelector('.bang').hidden = !err;
}

// ---- 장면 ----

function clockNow() {
  return mode === 'live' ? Math.max(Date.now(), tl.end) : tl.toT(v);
}

function render(clock) {
  const sc = sceneAt(sorted, [...agents.values()], clock, contextLimit);
  const taken = {}; // 방마다 몇 명째인지(겹치지 않게)
  const slot = (where) => (taken[where] = (taken[where] ?? -1) + 1);
  const staff = charEl('main', 'staff');
  put(staff, sc.staff.place, slot(sc.staff.place), sc.staff.bubble, sc.staff.err);
  const pct = Math.min(100, (sc.ctx.used / sc.ctx.limit) * 100);
  const g = staff.querySelector('.gauge i');
  g.style.width = `${pct}%`;
  g.style.background = pct > 90 ? 'var(--err)' : pct > 70 ? 'var(--warn)' : 'var(--good)';
  staff.querySelector('.gauge').title = `문맥(추정) ${fmtK(sc.ctx.used)} / ${fmtK(sc.ctx.limit)}`;
  const here = new Set(['main']);
  for (const it of sc.interns) {
    here.add(it.id);
    const el = charEl(it.id, 'intern');
    el.hidden = false;
    put(el, it.place, slot(it.place), it.bubble, it.err);
  }
  for (const [who, el] of chars) if (!here.has(who)) el.hidden = true;
  for (const [place, r] of Object.entries(rooms)) {
    r.count.textContent = String(sc.counts[place] ?? 0);
    r.el.classList.toggle('active', sc.active.includes(place));
  }
  showFeed(sc.feed, clock);
  showSummary(sc, clock);
}

let feedKey = '';
function showFeed(feed, clock) {
  const done = feed.filter((s) => s.end != null && s.end <= clock).length;
  const key = `${current}:${version}:${feed.length}:${done}`;
  if (key === feedKey) return;
  feedKey = key;
  const box = $('feed');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
  box.replaceChildren(...feed.slice(-MAX_FEED).map((s) => {
    const d = document.createElement('div');
    if (s.who !== 'main') d.classList.add('sub');
    else if (s.kind === 'user') d.classList.add('user');
    const ended = s.end != null && s.end <= clock;
    const failed = ended && s.ok === false;
    if (failed) d.classList.add('err');
    const dur = ended ? ` (${fmtDur(s.end - s.t)})` : s.kind === 'tool' ? ' …' : '';
    d.textContent = `${hhmmss(s.t)} ${failed ? '✗ ' : ''}${bubbleOf(s)}${dur}`;
    d.title = d.textContent;
    d.onclick = () => showDetail(s.id);
    return d;
  }));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function showSummary(sc, clock) {
  if (!sorted.length) {
    $('summary').textContent = '';
    return;
  }
  const tools = sc.feed.filter((s) => s.kind === 'tool');
  const errs = tools.filter((s) => s.ok === false && s.end <= clock).length;
  const out = sc.feed.reduce((n, s) => n + (s.tokens?.out ?? 0), 0);
  const interns = [...agents.values()].filter((a) => a.start != null && a.start <= clock).length;
  $('summary').textContent = `시작 ${hhmmss(tl.start)} · 경과 ${fmtDur(Math.max(0, clock - tl.start))} · 도구 ${tools.length}회 · 에러 ${errs} · 출력 토큰 ${fmtK(out)} · 인턴 ${interns}`;
}

function showMarks() {
  $('marks').replaceChildren(...markers(sorted, [...agents.values()]).map((m) => {
    const i = document.createElement('i');
    i.className = `m-${m.kind}`;
    i.style.left = `${tl.total ? (tl.toV(m.t) / tl.total) * 100 : 0}%`;
    return i;
  }));
}

// ---- 상세 ----

function showFeedPanel() {
  detailId = null;
  $('feed').hidden = false;
  $('detail').hidden = true;
  $('back').hidden = true;
  $('sidetitle').textContent = '활동';
}
$('back').onclick = showFeedPanel;

async function showDetail(id) {
  detailId = id;
  $('feed').hidden = true;
  $('detail').hidden = false;
  $('back').hidden = false;
  $('sidetitle').textContent = '상세';
  $('detail').textContent = '불러오는 중…';
  const res = await fetch(`/step?session=${encodeURIComponent(current)}&step=${encodeURIComponent(id)}`).catch(() => null);
  if (detailId !== id) return;
  if (!res?.ok) {
    $('detail').textContent = '상세를 불러오지 못했습니다.';
    return;
  }
  const d = await res.json();
  if (detailId !== id) return;
  const s = d.step;
  const rows = [
    ['종류', s.kind === 'tool' ? `${s.tool} (${ROOMS[s.place]?.name ?? s.place})` : bubbleOf(s)],
    ['시각', `${hhmmss(s.t)}${s.end != null ? ` → ${hhmmss(s.end)} (${fmtDur(s.end - s.t)})` : ''}`],
    s.kind === 'tool' ? ['결과', s.ok === false ? '실패' : s.ok ? '성공' : '진행 중'] : null,
    s.tokens ? ['토큰', `입력 ${s.tokens.in} · 캐시 ${s.tokens.cache} · 출력 ${s.tokens.out}`] : null,
    s.thinkMs != null ? ['생각', fmtDur(s.thinkMs)] : null,
    s.skill ? ['스킬', s.skill] : null,
    s.who !== 'main' ? ['누가', `인턴: ${agents.get(s.who)?.role ?? s.who}`] : null,
  ].filter(Boolean);
  const box = $('detail');
  box.replaceChildren();
  for (const [k, val] of rows) {
    const p = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = `${k} `;
    p.append(b, val);
    box.append(p);
  }
  for (const [k, part] of [['입력', d.input], ['결과', d.result]]) {
    if (!part) continue;
    const h = document.createElement('h3');
    h.textContent = part.truncated ? `${k} (앞 20KB만)` : k;
    const pre = document.createElement('pre');
    pre.textContent = part.text;
    box.append(h, pre);
  }
}

// ---- 재생 ----

function setMode(m) {
  mode = m;
  $('toggle').textContent = m === 'play' ? '❚❚' : '▶';
  $('live').classList.toggle('on', m === 'live');
  conn();
}

function conn(err) {
  const el = $('conn');
  el.textContent = err ?? (gone ? '기록이 끊김' : mode === 'live' ? '● 실시간' : '재생');
  el.className = err || gone ? '' : mode === 'live' ? 'live' : 'replay';
}

$('toggle').onclick = () => {
  if (mode === 'play') return setMode('pause');
  if (mode === 'live' || v >= tl.total) v = 0;
  setMode('play');
};
for (const b of document.querySelectorAll('[data-speed]')) {
  b.classList.toggle('on', Number(b.dataset.speed) === speed);
  b.onclick = () => {
    speed = Number(b.dataset.speed);
    for (const x of document.querySelectorAll('[data-speed]')) x.classList.toggle('on', x === b);
  };
}
$('pos').oninput = () => {
  dragging = true;
  v = (Number($('pos').value) / 1000) * tl.total;
  if (mode !== 'pause') setMode('pause');
};
$('pos').onchange = () => (dragging = false);
$('live').onclick = () => setMode('live');

let lastFrame = 0;
let lastRender = 0;
let renderedVersion = -1;
function frame(ts) {
  const dt = lastFrame ? ts - lastFrame : 0;
  lastFrame = ts;
  if (mode === 'play') {
    v += dt * speed;
    if (v >= tl.total) {
      v = tl.total;
      setMode('pause');
    }
  }
  if (mode === 'live') v = tl.total;
  if (ts - lastRender >= RENDER_MS || version !== renderedVersion || dragging) {
    lastRender = ts;
    renderedVersion = version;
    const clock = clockNow();
    render(clock);
    $('clock').textContent = sorted.length ? hhmmss(clock) : '';
    if (!dragging) $('pos').value = String(tl.total ? Math.round((v / tl.total) * 1000) : 1000);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- 세션 ----

function open(id, live) {
  es?.close();
  current = id;
  steps = new Map();
  agents = new Map();
  sorted = [];
  tl = timeline([]);
  gone = false;
  v = 0;
  version++;
  for (const el of chars.values()) el.remove();
  chars.clear();
  showFeedPanel();
  setMode(live ? 'live' : 'pause');
  es = new EventSource(`/stream?session=${encodeURIComponent(id)}`);
  es.onopen = () => conn();
  es.onerror = () => conn('연결 끊김 — 다시 연결하는 중');
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.session) {
      // 첫 메시지(다시 연결 포함)는 전부를 담고 있다
      steps = new Map();
      agents = new Map();
      if (msg.contextLimit > 0) contextLimit = msg.contextLimit;
    }
    for (const s of msg.steps ?? []) steps.set(s.id, s);
    for (const a of msg.agents ?? []) agents.set(a.id, a);
    if (msg.gone) gone = true;
    sorted = [...steps.values()].sort((a, b) => a.t - b.t);
    tl = timeline(sorted);
    version++;
    showMarks();
    conn();
  };
}

async function loadSessions() {
  const data = await (await fetch('/sessions')).json();
  if (!data.found) {
    $('empty').hidden = false;
    $('empty').textContent = `클로드 코드 기록을 찾지 못함 (${data.root})`;
    return;
  }
  const sel = $('sessions');
  sel.replaceChildren(...data.sessions.map((s) => {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.live ? '● ' : ''}${s.project} · ${s.title}`;
    o.dataset.live = s.live ? '1' : '';
    return o;
  }));
  const asked = new URLSearchParams(location.search).get('session');
  const pick = data.sessions.find((s) => s.id === asked) ?? data.sessions.find((s) => s.live) ?? data.sessions[0];
  if (!pick) {
    $('empty').hidden = false;
    $('empty').textContent = '세션 기록이 없습니다.';
    return;
  }
  sel.value = pick.id;
  open(pick.id, pick.live);
}
$('sessions').onchange = (e) => open(e.target.value, e.target.selectedOptions[0]?.dataset.live === '1');
loadSessions();
```

- [ ] **Step 5: 확인 스크립트 통과**

Run: `cd <scratchpad> && CHROMIUM_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" fnm exec --using=22 node office-check.cjs`
Expected: `실시간 반영 <2000 ms` 다음 `OK`.
그다음 `office-1.png`·`office-2.png`를 열어 본다: 9개 방이 각각 알아볼 만한 가구로 채워졌는지, 직원·인턴이 사람 모양인지. 칸 좌표가 엉뚱하면(예: 침대·촛대가 나옴) `public/art.mjs`의 `ROOMS`·`CHAR` 좌표만 고치고(`g-indoor-a.png`·`g-indoor-b.png`·`g-chars-a.png`의 칸 번호 참고) 다시 확인한다 — ledger에 `Ruling:`으로 남긴다.

- [ ] **Step 6: 실제 기록 열기 시간**

이 대화 기록(약 47MB)을 실제 기록 폴더로 연다(읽기만). 별도 포트로 서버를 띄워 확인:
```bash
PORT=7812 fnm exec --using=22 node server/server.js &
```
Playwright로 `http://127.0.0.1:7812/?session=C--/a9d50998-9a54-4325-9272-01fb9ae5fce8`를 열어 `#feed div`가 생길 때까지 걸린 시간을 잰다.
Expected: 10초 안. 확인 후 그 서버를 끈다(7812만).

- [ ] **Step 7: README와 전체 테스트**

`README.md`:
````markdown
# claude-office

클로드 코드에 일을 시키면 무엇을 어떤 순서로 하는지, 세션 기록을 픽셀아트 사무실로 보여 준다.

- 끝난 세션: ▶ 재생(×1·×8·×32), 띠를 끌어 원하는 순간으로. 5초 넘는 빈 시간은 1초로 줄인다.
- 진행 중인 세션(최근 60초 안에 기록이 바뀐 세션): 1~2초 늦게 실시간으로 따라간다.
- 클로드(주황 셔츠)는 도구를 쓸 때마다 그 방으로 간다. 하위 에이전트는 인턴(보라 셔츠).

| 방 | 도구 |
|---|---|
| 서가 | Read |
| 내 책상 | Edit, Write |
| 서버실 | Bash, PowerShell |
| 찾기 책상 | Grep, Glob |
| 창문 | WebFetch, WebSearch, 브라우저 |
| 매뉴얼 선반 | Skill, ToolSearch |
| 회의실 | 사용자 요청, 질문, 답변 |
| 인턴 자리 | Agent |
| 기타 | 그 밖의 도구 |

## 실행

```bash
npm start            # http://localhost:7800
npm test
```

환경 변수: `PORT`(7800), `CLAUDE_PROJECTS`(기본 `~/.claude/projects`), `CONTEXT_LIMIT`(문맥 막대 기준, 기본 200000).

## 알아둘 것

- 기록(`~/.claude/projects`)은 읽기만 한다. 클로드 코드 설정·훅은 건드리지 않는다.
- 기록에 코드·경로·명령 결과가 그대로 있으므로 이 PC(127.0.0.1)에서만 열린다.
- 보이는 것은 기록에 남은 과정이다(모델 내부 계산이 아니다). 생각 내용은 대부분 기록에 남지 않아 시간만 보인다. 문맥 막대는 추정이다.
- 기록 읽기 규칙은 공식 `session-report` 스킬(Apache 2.0)의 정리를 참고했다.
- 그림: [Kenney](https://kenney.nl) Roguelike Indoor·Roguelike Characters (CC0, `public/art/LICENSE-kenney.txt`).
````

Run: `fnm exec --using=22 npm.cmd test`
Expected: PASS (22 + scene 4 + art 3 = 29)

- [ ] **Step 8: 커밋**

```bash
git add public/index.html public/app.mjs README.md public/art.mjs
git commit -m "feat(public): 사무실 화면(세션 고르기·재생 띠·실시간·피드·상세)과 README"
```
