// 파일 끝에 새로 붙은 줄만 읽는다(진행 중인 세션 따라가기). 세션 하나 = 본 기록 + subagents/*.jsonl
const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { createParser } = require('./parse');

const CHUNK = 16 * 1024 * 1024; // 한 번에 읽는 최대 바이트(큰 기록도 문자열 하나로 만들지 않는다)
const LIVE_MS = 60 * 1000;      // meta에 finished가 없는 인턴: 이 안에 파일이 바뀌었으면 일하는 중

function createTail(file, chunk = CHUNK) {
  let pos = 0;
  let behind = false; // 파일 끝까지 아직 못 읽음
  let rest = '';
  let dec = new StringDecoder('utf8'); // 한글이 읽기 경계에서 잘려도 다음 번에 이어 붙인다
  return {
    // 완성된 줄 목록(최대 chunk 바이트어치). 파일이 없으면 null
    read() {
      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        return null;
      }
      if (size < pos) {
        // 새로 쓰여 짧아졌으면 처음부터(이미 본 줄은 parse가 uuid로 거른다)
        pos = 0;
        rest = '';
        dec = new StringDecoder('utf8');
      }
      if (size === pos) {
        behind = false;
        return [];
      }
      const buf = Buffer.alloc(Math.min(chunk, size - pos));
      const fd = fs.openSync(file, 'r');
      let off = 0;
      try {
        while (off < buf.length) {
          const n = fs.readSync(fd, buf, off, buf.length - off, pos + off);
          if (n === 0) break;
          off += n;
        }
      } finally {
        fs.closeSync(fd);
      }
      pos += off;
      behind = off > 0 && pos < size;
      rest += dec.write(buf.subarray(0, off));
      const lines = rest.split('\n');
      rest = lines.pop();
      return lines.filter((l) => l.trim());
    },
    get behind() {
      return behind;
    },
  };
}

// 끝까지 따라잡을 때까지 chunk씩 읽어 줄마다 fn. 파일이 없으면 false
function drain(tail, fn) {
  do {
    const lines = tail.read();
    if (lines === null) return false;
    for (const l of lines) fn(l);
  } while (tail.behind);
  return true;
}

function createReader(file, { chunk = CHUNK } = {}) {
  const subDir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  const main = { tail: createTail(file, chunk), parser: createParser('main') };
  const subs = new Map(); // agentId → { tail, parser, info }
  let gone = false;

  function agentInfo(id, sub) {
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(subDir, `agent-${id}.meta.json`), 'utf8'));
    } catch {
      // meta가 없는 옛 기록: 파일 이름만으로
    }
    if (!meta || typeof meta !== 'object') meta = null;
    let start = null;
    let last = null;
    for (const s of sub.parser.steps()) {
      if (start === null || s.t < start) start = s.t;
      const e = s.end ?? s.t;
      if (last === null || e > last) last = e;
    }
    return {
      id,
      role: typeof meta?.description === 'string' ? meta.description : '인턴',
      type: typeof meta?.agentType === 'string' ? meta.agentType : null,
      parentStep: (meta && main.parser.stepOfTool(meta.toolUseId)?.id) ?? null,
      start,
      end: running(id, meta) ? null : last,
    };
  }

  // meta가 없으면 끝난 것. finished:false면 일하는 중. finished가 없는 옛 형식은 최근 1분 안에 파일이 바뀌었을 때만 일하는 중
  function running(id, meta) {
    if (!meta || meta.finished === true) return false;
    if (meta.finished === false) return true;
    try {
      return Date.now() - fs.statSync(path.join(subDir, `agent-${id}.jsonl`)).mtimeMs < LIVE_MS;
    } catch {
      return false;
    }
  }

  // 늘어난 줄을 읽어 새로 생기거나 바뀐 단계·인턴만 돌려준다
  function poll() {
    if (gone) return { steps: [], agents: [], gone: true };
    const changed = new Set();
    if (!drain(main.tail, (l) => { for (const s of main.parser.line(l)) changed.add(s); })) {
      gone = true;
      return { steps: [], agents: [], gone: true };
    }
    let files = [];
    try {
      files = fs.readdirSync(subDir);
    } catch {
      // 하위 에이전트 없음
    }
    const agents = [];
    for (const f of files) {
      const m = /^agent-([\w-]+)\.jsonl$/.exec(f);
      if (!m) continue;
      let sub = subs.get(m[1]);
      if (!sub) {
        sub = { tail: createTail(path.join(subDir, f), chunk), parser: createParser(m[1]), info: null };
        subs.set(m[1], sub);
      }
      drain(sub.tail, (l) => { for (const s of sub.parser.line(l)) changed.add(s); });
      const info = agentInfo(m[1], sub);
      if (JSON.stringify(info) !== JSON.stringify(sub.info)) {
        sub.info = info;
        agents.push(info);
      }
    }
    return { steps: [...changed], agents, gone: false };
  }

  const parsers = () => [main.parser, ...[...subs.values()].map((s) => s.parser)];

  return {
    poll,
    all: () => ({
      steps: parsers().flatMap((p) => p.steps()).sort((a, b) => a.t - b.t),
      agents: [...subs.values()].map((s) => s.info).filter(Boolean),
    }),
    detail(stepId) {
      const id = String(stepId);
      const who = id.slice(0, id.lastIndexOf(':'));
      const p = who === 'main' ? main.parser : subs.get(who)?.parser;
      const step = p?.step(id);
      if (!step) return null;
      const d = p.detail(id);
      return { step, input: d?.input ?? null, result: d?.result ?? null };
    },
    get title() {
      return main.parser.title;
    },
  };
}

module.exports = { createTail, createReader };
