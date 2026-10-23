import test from 'node:test';
import assert from 'node:assert/strict';
import { buckets, pickOps, shown, stats } from '../public/ops.mjs';

const s = (id, live = false) => ({ id, live });

test('pickOps: 진행 중인 세션만 최대 4개, 없으면 빈 목록', () => {
  assert.deepEqual(pickOps([s('a'), s('b', true), s('c', true)]), ['b', 'c']);
  assert.deepEqual(pickOps([1, 2, 3, 4, 5, 6].map((i) => s(`l${i}`, true))), ['l1', 'l2', 'l3', 'l4']);
  assert.deepEqual(pickOps([s('a'), s('b')]), []);
});

test('shown: 도구 실행과 사용자 요청만 줄로 띄운다(생각·답변·정리는 뺀다)', () => {
  assert.deepEqual(['tool', 'user', 'think', 'answer', 'compact'].map((kind) => shown({ kind })), [true, true, false, false, false]);
});

test('stats: 그 순간까지의 도구 횟수·끝난 실패·출력 토큰·나타난 인턴', () => {
  const steps = [
    { kind: 'user', t: 0 },
    { kind: 'tool', t: 1, end: 2, ok: true, tokens: { out: 30 } },
    { kind: 'tool', t: 3, end: 5, ok: false, tokens: { out: 12 } },
    { kind: 'answer', t: 6, tokens: { out: 100 } },
  ];
  const agents = [{ start: 2 }, { start: 9 }, { start: null }];
  assert.deepEqual(stats(steps, agents, 4), { tools: 2, errors: 0, out: 42, interns: 1 });
  assert.deepEqual(stats(steps, agents, 10), { tools: 2, errors: 1, out: 142, interns: 2 });
});

test('buckets: now까지 size 단위 n칸에 시각을 센다(오래된 것은 버림)', () => {
  assert.deepEqual(buckets([100, 9000, 15000, 29999, 30000, -5], 30000, 10000, 3), [2, 1, 2]);
  assert.deepEqual(buckets([], 0, 10000, 2), [0, 0]);
});
