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
