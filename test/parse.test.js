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
