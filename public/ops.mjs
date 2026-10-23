// 관제실: 띄울 세션 고르기, 띄울 줄 고르기, 카운터, 처리량. 화면과 떨어진 순수 함수
import { MAX_CELLS } from './grid.mjs';

// 진행 중인 세션(최근 60초 안에 기록이 바뀐 것)만
export const pickOps = (sessions) => sessions.filter((s) => s.live).slice(0, MAX_CELLS).map((s) => s.id);

// 줄로 띄울 단계: 도구 실행과 사용자 요청만(생각·답변 글은 길어서 뺀다)
export const shown = (s) => s.kind === 'tool' || s.kind === 'user';

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
