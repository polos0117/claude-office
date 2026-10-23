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

test('reader: meta에 finished가 없으면(옛 형식) 파일이 1분 넘게 안 바뀐 인턴은 끝난 것, 최근에 바뀌면 일하는 중', (t) => {
  const d = tmp(t);
  const f = path.join(d, 'sess.jsonl');
  fs.writeFileSync(f, tool(0, 'call1', 'Agent', { description: 'Scan' }));
  const sub = path.join(d, 'sess', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const file = path.join(sub, 'agent-abc.jsonl');
  fs.writeFileSync(file, tool(1, 's1', 'Read', { file_path: 'a.js' }) + result(5, 's1', 'ok'));
  fs.writeFileSync(path.join(sub, 'agent-abc.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Scan', toolUseId: 'call1' }));
  assert.equal(createReader(f).poll().agents[0].end, null); // 방금 쓴 파일 = 진행 중일 수 있다
  const old = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(file, old, old);
  assert.equal(createReader(f).poll().agents[0].end, Date.parse(at(5)));
});

test('reader: 한 번에 읽는 양(chunk)보다 큰 기록도 poll 한 번에 끝까지 읽는다', (t) => {
  const f = path.join(tmp(t), 's.jsonl');
  fs.writeFileSync(f, human(0, '하나') + human(1, '둘') + human(2, '셋'));
  const tail = createTail(f, 40);
  const first = tail.read();
  assert.ok(first.length < 3);
  assert.equal(tail.behind, true);
  const r = createReader(f, { chunk: 40 });
  assert.deepEqual(r.poll().steps.map((s) => s.summary), ['하나', '둘', '셋']);
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
