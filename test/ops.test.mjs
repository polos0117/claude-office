import test from 'node:test';
import assert from 'node:assert/strict';
import { buckets, pickOps, replayClock, stats } from '../public/ops.mjs';
import { timeline } from '../public/scene.mjs';

const s = (id, live = false) => ({ id, live });

test('pickOps: 진행 중인 세션이 있으면 실시간(최대 4개), 없으면 최근 4개 다시 보기, 없으면 빈 목록', () => {
  assert.deepEqual(pickOps([s('a'), s('b', true), s('c', true)]), { mode: 'live', ids: ['b', 'c'] });
  assert.deepEqual(pickOps([1, 2, 3, 4, 5, 6].map((i) => s(`l${i}`, true))).ids, ['l1', 'l2', 'l3', 'l4']);
  assert.deepEqual(pickOps([s('a'), s('b'), s('c'), s('d'), s('e')]), { mode: 'replay', ids: ['a', 'b', 'c', 'd'] });
  assert.deepEqual(pickOps([]), { mode: 'replay', ids: [] });
});

test('replayClock: 빈 시간을 줄여 speed배로 흐르고, 끝에서 잠깐 멈춘 뒤 처음부터(lap+1)', () => {
  const tl = timeline([{ t: 0 }, { t: 1000 }, { t: 61000 }]); // 1초 + (60초→1초) = 재생 2초
  assert.deepEqual(replayClock(tl, 0, 8, 1000), { t: 0, lap: 0 });
  assert.deepEqual(replayClock(tl, 125, 8, 1000), { t: 1000, lap: 0 });
  assert.equal(replayClock(tl, 250, 8, 1000).t, 61000);
  assert.deepEqual(replayClock(tl, 1200, 8, 1000), { t: 61000, lap: 0 }); // 끝에서 멈춤
  assert.deepEqual(replayClock(tl, 1250, 8, 1000), { t: 0, lap: 1 });
  assert.deepEqual(replayClock(timeline([]), 5000, 8, 1000), { t: 0, lap: 0 });
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
