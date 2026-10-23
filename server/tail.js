// 파일 끝에 새로 붙은 줄만 읽는다(진행 중인 세션 따라가기). 세션 하나 = 본 기록 + subagents/*.jsonl
const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { createParser } = require('./parse');

function createTail(file) {
  let pos = 0;
  let rest = '';
  let dec = new StringDecoder('utf8'); // 한글이 읽기 경계에서 잘려도 다음 번에 이어 붙인다
  return {
    // 완성된 줄 목록. 파일이 없으면 null
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
      if (size === pos) return [];
      const buf = Buffer.alloc(size - pos);
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
      rest += dec.write(buf.subarray(0, off));
      const lines = rest.split('\n');
      rest = lines.pop();
      return lines.filter((l) => l.trim());
    },
  };
}

function createReader(file) {
  const subDir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  const main = { tail: createTail(file), parser: createParser('main') };
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
      end: meta && meta.finished !== true ? null : last, // meta가 없으면 마지막 단계에서 끝난 것으로 본다
    };
  }

  // 늘어난 줄을 읽어 새로 생기거나 바뀐 단계·인턴만 돌려준다
  function poll() {
    if (gone) return { steps: [], agents: [], gone: true };
    const lines = main.tail.read();
    if (lines === null) {
      gone = true;
      return { steps: [], agents: [], gone: true };
    }
    const changed = new Set();
    for (const l of lines) for (const s of main.parser.line(l)) changed.add(s);
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
        sub = { tail: createTail(path.join(subDir, f)), parser: createParser(m[1]), info: null };
        subs.set(m[1], sub);
      }
      for (const l of sub.tail.read() ?? []) for (const s of sub.parser.line(l)) changed.add(s);
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
