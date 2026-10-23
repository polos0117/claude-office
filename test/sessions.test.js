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
