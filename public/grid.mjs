// 여러 세션 보기: 처음에 띄울 칸 고르기
export const MAX_CELLS = 4; // 칸마다 실시간 연결 하나. 브라우저는 한 주소에 6개까지만 열어 둔다

// asked(주소에 적힌 id 목록)가 있으면 그것, 없으면 진행 중인 세션들, 그것도 없으면 가장 최근 하나
export function pickCells(sessions, asked) {
  const ids = new Set(sessions.map((s) => s.id));
  const fromUrl = [...new Set(asked ?? [])].filter((id) => ids.has(id));
  if (fromUrl.length) return fromUrl.slice(0, MAX_CELLS);
  const live = sessions.filter((s) => s.live).map((s) => s.id);
  return (live.length ? live : sessions.slice(0, 1).map((s) => s.id)).slice(0, MAX_CELLS);
}
