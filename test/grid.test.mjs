import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CELLS, pickCells } from '../public/grid.mjs';

const s = (id, live = false) => ({ id, live });
const list = [s('p/a'), s('p/b', true), s('p/c'), s('p/d', true), s('p/e', true), s('p/f', true), s('p/g', true)];

test('pickCells: 주소에 적힌 세션을 그 순서대로, 없는 것·중복은 빼고 최대 4개', () => {
  assert.equal(MAX_CELLS, 4);
  assert.deepEqual(pickCells(list, ['p/c', 'p/nope', 'p/a', 'p/c']), ['p/c', 'p/a']);
  assert.deepEqual(pickCells(list, ['p/a', 'p/b', 'p/c', 'p/d', 'p/e']), ['p/a', 'p/b', 'p/c', 'p/d']);
});

test('pickCells: 주소에 없으면(또는 다 없는 세션이면) 진행 중인 세션 최대 4개', () => {
  assert.deepEqual(pickCells(list, null), ['p/b', 'p/d', 'p/e', 'p/f']);
  assert.deepEqual(pickCells(list, ['p/nope']), ['p/b', 'p/d', 'p/e', 'p/f']);
});

test('pickCells: 진행 중인 세션이 없으면 가장 최근 하나, 세션이 없으면 빈 목록', () => {
  assert.deepEqual(pickCells([s('p/x'), s('p/y')], null), ['p/x']);
  assert.deepEqual(pickCells([], null), []);
});
