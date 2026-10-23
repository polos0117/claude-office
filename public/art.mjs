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
