// 클로드 코드 기록(JSONL) 한 줄 → 화면에 그릴 '단계'.
// 형식 규칙은 공식 session-report 스킬(analyze-sessions.mjs)이 정리한 것을 따른다.

const MAX_DETAIL = 20 * 1024; // 상세(입력·결과) 한 칸 최대 글자 수

const PLACES = new Map([
  ['Read', 'shelf'],
  ['Edit', 'desk'], ['Write', 'desk'], ['NotebookEdit', 'desk'],
  ['Bash', 'server'], ['PowerShell', 'server'],
  ['Grep', 'search'], ['Glob', 'search'],
  ['WebFetch', 'window'], ['WebSearch', 'window'],
  ['Skill', 'manual'], ['ToolSearch', 'manual'],
  ['AskUserQuestion', 'meeting'],
  ['Agent', 'intern'],
]);

function placeOf(tool) {
  if (PLACES.has(tool)) return PLACES.get(tool);
  if (String(tool).startsWith('mcp__claude-in-chrome__')) return 'window';
  return 'misc';
}

function cut(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
const base = (p) => String(p ?? '').split(/[\\/]/).pop();

function summaryOf(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  switch (tool) {
    case 'Read': case 'Edit': case 'Write': return cut(base(i.file_path), 60);
    case 'NotebookEdit': return cut(base(i.notebook_path), 60);
    case 'Bash': case 'PowerShell': return cut(i.description || i.command, 60);
    case 'Grep': case 'Glob': return cut(i.pattern, 60);
    case 'WebFetch': return cut(i.url, 60);
    case 'WebSearch': return cut(i.query, 60);
    case 'Skill': return cut(i.skill, 60);
    case 'Agent': return cut(i.description, 60);
    case 'AskUserQuestion': return cut(i.questions?.[0]?.question, 60);
    default: return cut(tool, 60);
  }
}

// 사람이 직접 쓴 요청이면 그 글, 아니면 null(도구 결과·메타·압축 요약·중단 표시·하위 에이전트)
function humanText(rec) {
  if (rec.type !== 'user' || rec.isSidechain || rec.isMeta || rec.isCompactSummary) return null;
  const c = rec.message?.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c) && c.length > 0 && c.every((b) => b?.type === 'text')) text = c.map((b) => b.text ?? '').join('\n');
  if (text === null || !text.trim() || text.startsWith('[Request interrupted')) return null;
  return text;
}

function clip(s) {
  const t = String(s ?? '');
  return t.length > MAX_DETAIL ? { text: t.slice(0, MAX_DETAIL), truncated: true } : { text: t, truncated: false };
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b?.type === 'text' ? b.text : `[${b?.type ?? '?'}]`)).join('\n');
  return JSON.stringify(content ?? '');
}

function createParser(who = 'main') {
  const steps = new Map();     // id → 단계(화면에 보내는 것)
  const details = new Map();   // id → { input, result } (누르면 보여 주는 것)
  const seen = new Set();      // uuid(이어 연 세션은 앞 줄을 다시 쓴다)
  const byTool = new Map();    // tool_use_id → 단계
  const byRequest = new Map(); // requestId → 토큰을 싣는 단계(응답 하나가 여러 줄로 나뉜다)
  let n = 0;
  let title = null;

  const add = (step, detail) => {
    step.id = `${who}:${n++}`;
    step.who = who;
    steps.set(step.id, step);
    if (detail) details.set(step.id, detail);
    return step;
  };

  function assistant(rec, t) {
    const out = [];
    const blocks = Array.isArray(rec.message?.content) ? rec.message.content : [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      let s = null;
      if (b.type === 'thinking') {
        s = add(
          { kind: 'think', t, thinkMs: Number.isFinite(rec.thinkingDurationMs) ? rec.thinkingDurationMs : null, thinkText: b.thinking ? cut(b.thinking, 200) : null },
          b.thinking ? { input: null, result: clip(b.thinking) } : null,
        );
      } else if (b.type === 'tool_use') {
        const tool = String(b.name ?? '?');
        s = add(
          { kind: 'tool', t, tool, place: placeOf(tool), summary: summaryOf(tool, b.input), end: null, ok: null },
          { input: clip(JSON.stringify(b.input ?? null, null, 2)), result: null },
        );
        if (b.id) byTool.set(b.id, s);
      } else if (b.type === 'text' && String(b.text ?? '').trim()) {
        s = add({ kind: 'answer', t, place: 'meeting', summary: cut(b.text, 80) }, { input: null, result: clip(b.text) });
      }
      if (!s) continue;
      if (rec.attributionSkill) s.skill = String(rec.attributionSkill);
      out.push(s);
    }
    const u = rec.message?.usage;
    if (u && typeof u === 'object') {
      const req = rec.requestId ?? rec.message?.id ?? rec.uuid;
      let s = byRequest.get(req);
      if (!s && out.length) {
        s = out[0];
        byRequest.set(req, s);
      }
      if (s) {
        const tok = { in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cache: (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) };
        s.tokens = s.tokens
          ? { in: Math.max(s.tokens.in, tok.in), out: Math.max(s.tokens.out, tok.out), cache: Math.max(s.tokens.cache, tok.cache) }
          : tok;
        if (!out.includes(s)) out.push(s);
      }
    }
    return out;
  }

  function user(rec, t) {
    const out = [];
    const c = rec.message?.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type !== 'tool_result') continue;
        const s = byTool.get(b.tool_use_id);
        if (!s || s.end !== null) continue;
        s.end = t;
        s.ok = b.is_error !== true;
        details.get(s.id).result = clip(resultText(b.content));
        out.push(s);
      }
    }
    const text = humanText(rec);
    if (text !== null) out.push(add({ kind: 'user', t, place: 'meeting', summary: cut(text, 80) }, { input: null, result: clip(text) }));
    return out;
  }

  // 한 줄 → 새로 생기거나 바뀐 단계들. 모르는 줄·깨진 줄은 []
  function line(text) {
    let rec;
    try {
      rec = JSON.parse(text);
    } catch {
      return [];
    }
    if (!rec || typeof rec !== 'object') return [];
    if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') {
      title = rec.aiTitle;
      return [];
    }
    if (typeof rec.uuid === 'string') {
      if (seen.has(rec.uuid)) return [];
      seen.add(rec.uuid);
    }
    const t = Date.parse(rec.timestamp);
    if (!Number.isFinite(t)) return [];
    if (rec.type === 'assistant') return assistant(rec, t);
    if (rec.type === 'user') return user(rec, t);
    if (rec.type === 'system' && rec.subtype === 'compact_boundary') return [add({ kind: 'compact', t })];
    return [];
  }

  return {
    line,
    steps: () => [...steps.values()],
    step: (id) => steps.get(id) ?? null,
    detail: (id) => details.get(id) ?? null,
    stepOfTool: (toolUseId) => byTool.get(toolUseId) ?? null,
    get title() {
      return title;
    },
  };
}

module.exports = { createParser, placeOf, summaryOf, humanText, cut, MAX_DETAIL };
