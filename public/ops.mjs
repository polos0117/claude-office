// 관제실: 띄울 세션 고르기, 다시 보기 시계, 카운터, 처리량. 화면과 떨어진 순수 함수
import { MAX_CELLS } from './grid.mjs';

// 진행 중인 세션이 있으면 그것들을 실시간으로, 없으면 최근 세션들의 실제 기록을 다시 흘린다
export function pickOps(sessions) {
  const live = sessions.filter((s) => s.live);
  return live.length
    ? { mode: 'live', ids: live.slice(0, MAX_CELLS).map((s) => s.id) }
    : { mode: 'replay', ids: sessions.slice(0, MAX_CELLS).map((s) => s.id) };
}

// 다시 보기: 시작 후 elapsed(ms)일 때의 기록 시각. 빈 시간을 줄인 timeline을 speed배로, 끝에서 hold(ms) 멈춘 뒤 처음부터
export function replayClock(tl, elapsed, speed, hold) {
  if (!tl.total) return { t: tl.start, lap: 0 };
  const cycle = tl.total / speed + hold;
  const lap = Math.floor(elapsed / cycle);
  return { t: tl.toT(Math.min((elapsed - lap * cycle) * speed, tl.total)), lap };
}

export function stats(steps, agents, clock) {
  let tools = 0;
  let errors = 0;
  let out = 0;
  for (const s of steps) {
    if (s.t > clock) continue;
    if (s.kind === 'tool') {
      tools++;
      if (s.ok === false && s.end != null && s.end <= clock) errors++;
    }
    out += s.tokens?.out ?? 0;
  }
  const interns = agents.filter((a) => a.start != null && a.start <= clock).length;
  return { tools, errors, out, interns };
}

// now까지 size(ms) 단위 n칸에 times를 센다
export function buckets(times, now, size, n) {
  const out = new Array(n).fill(0);
  const from = now - n * size;
  for (const x of times) if (x >= from && x <= now) out[Math.min(n - 1, Math.floor((x - from) / size))]++;
  return out;
}
