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
