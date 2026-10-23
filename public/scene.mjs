// 단계 목록 + 시계 → 그 순간의 장면(누가 어느 방에, 말풍선, 방 횟수). 화면과 떨어진 순수 함수.

export const GAP_MS = 5000;   // 이보다 긴 빈 시간은
export const KEEP_MS = 1000;  // 이만큼으로 줄여 재생한다
export const ERR_MS = 2000;   // 실패 ❗를 띄우는 시간
export const LEAVE_MS = 1500; // 인턴이 일을 마치고 회의실에 들러 있는 시간

export const ICONS = { shelf: '📚', desk: '✏️', server: '▶', search: '🔍', window: '🪟', manual: '📘', meeting: '💬', intern: '🧑‍🎓', misc: '📦' };

// 정렬된 arr에서 arr[i] <= x인 마지막 i(범위 밖이면 양 끝)
function seg(arr, x) {
  let lo = 0;
  let hi = arr.length - 1;
  if (x <= arr[0]) return 0;
  if (x >= arr[hi]) return hi;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (arr[m] <= x) lo = m;
    else hi = m;
  }
  return lo;
}

// 실제 시각(t) ↔ 재생 시각(v). 긴 빈 시간은 keep으로 눌러 담는다. 끝 뒤는 그대로 흐른다(실시간)
export function timeline(steps, gap = GAP_MS, keep = KEEP_MS) {
  const ts = [...new Set(steps.flatMap((s) => (s.end != null ? [s.t, s.end] : [s.t])))].sort((a, b) => a - b);
  if (ts.length === 0) return { start: 0, end: 0, total: 0, toV: () => 0, toT: () => 0 };
  const vs = [0];
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i] - ts[i - 1];
    vs.push(vs[i - 1] + (d > gap ? keep : d));
  }
  const last = ts.length - 1;
  const toV = (t) => {
    if (t <= ts[0]) return 0;
    const i = seg(ts, t);
    if (i === last) return vs[i] + (t - ts[i]);
    return vs[i] + ((t - ts[i]) * (vs[i + 1] - vs[i])) / (ts[i + 1] - ts[i]);
  };
  const toT = (v) => {
    if (v <= 0) return ts[0];
    const i = seg(vs, v);
    if (i === last) return ts[i] + (v - vs[i]);
    return ts[i] + ((v - vs[i]) * (ts[i + 1] - ts[i])) / (vs[i + 1] - vs[i]);
  };
  return { start: ts[0], end: ts[last], total: vs[last], toV, toT };
}

export function bubbleOf(s) {
  if (s.kind === 'think') return `💭 ${s.thinkText ?? (s.thinkMs != null ? `생각 ${Math.max(1, Math.round(s.thinkMs / 1000))}초` : '생각 중')}`;
  if (s.kind === 'compact') return '📦 정리';
  if (s.kind === 'user') return `💬 ${s.summary}`;
  if (s.kind === 'answer') return `📝 ${s.summary}`;
  return `${ICONS[s.place] ?? '📦'} ${s.summary || s.tool}`;
}

export function fmtDur(ms) {
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}초`;
  const sec = Math.round(ms / 1000);
  if (sec < 3600) return `${Math.floor(sec / 60)}분 ${sec % 60}초`;
  const min = Math.floor(sec / 60);
  if (min < 24 * 60) return `${Math.floor(min / 60)}시간 ${min % 60}분`;
  return `${Math.floor(min / 1440)}일 ${Math.floor((min % 1440) / 60)}시간`;
}

// clock(실제 시각 ms) 순간의 장면. steps는 t 순
export function sceneAt(steps, agents, clock, contextLimit = 200000) {
  const feed = [];
  const counts = {};
  const actors = new Map(); // who → { place, bubble, busy, err }
  const errs = new Set();
  let used = 0;
  for (const s of steps) {
    if (s.t > clock) break;
    feed.push(s);
    const a = actors.get(s.who) ?? { place: s.who === 'main' ? 'desk' : 'intern', bubble: null, busy: false, err: false };
    if (s.place) {
      a.place = s.place;
      counts[s.place] = (counts[s.place] ?? 0) + 1;
    }
    a.bubble = bubbleOf(s);
    a.busy = s.kind === 'tool' && (s.end == null || s.end > clock);
    actors.set(s.who, a);
    if (s.kind === 'tool' && s.ok === false && s.end <= clock && clock < s.end + ERR_MS) errs.add(s.who);
    if (s.who === 'main' && s.tokens) used = s.tokens.in + s.tokens.cache;
    if (s.who === 'main' && s.kind === 'compact') used = 0;
  }
  const staff = { ...(actors.get('main') ?? { place: 'desk', bubble: null, busy: false, err: false }), err: errs.has('main') };
  const interns = [];
  for (const ag of agents) {
    if (ag.start == null || clock < ag.start) continue;
    if (ag.end != null && clock >= ag.end + LEAVE_MS) continue;
    const a = actors.get(ag.id) ?? { place: 'intern', bubble: null, busy: false, err: false };
    const leaving = ag.end != null && clock >= ag.end;
    interns.push({
      id: ag.id,
      role: ag.role,
      place: leaving ? 'meeting' : a.place,
      bubble: leaving ? `📋 ${ag.role} 보고` : a.bubble,
      busy: leaving ? false : a.busy,
      err: errs.has(ag.id),
    });
  }
  const active = [...new Set([staff, ...interns].filter((a) => a.busy).map((a) => a.place))];
  return { staff, interns, counts, active, ctx: { used, limit: contextLimit }, feed };
}

// 재생 띠 위 표시: 사용자 요청·실패·인턴 출발
export function markers(steps, agents) {
  const out = [];
  for (const s of steps) {
    if (s.kind === 'user') out.push({ t: s.t, kind: 'user' });
    else if (s.kind === 'tool' && s.ok === false && s.end != null) out.push({ t: s.end, kind: 'err' });
  }
  for (const a of agents) if (a.start != null) out.push({ t: a.start, kind: 'intern' });
  return out.sort((a, b) => a.t - b.t);
}
