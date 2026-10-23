// ~/.claude/projects 아래 세션 목록, 세션 id(<폴더>/<uuid>) → 기록 파일
const fs = require('node:fs');
const path = require('node:path');
const { humanText, cut } = require('./parse');

const LIVE_MS = 60 * 1000;  // 이 안에 바뀐 세션은 '진행 중'
const PEEK = 256 * 1024;    // 제목을 찾으려고 읽는 앞·뒤 크기
const titles = new Map();   // file → { mtime, title } ponytail: 세션 파일 수만큼만 커진다

function peek(file, size, fromEnd) {
  const n = Math.min(PEEK, size);
  const buf = Buffer.alloc(n);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, n, fromEnd ? size - n : 0);
  } finally {
    fs.closeSync(fd);
  }
  return buf.toString('utf8').split('\n'); // 앞뒤로 잘린 줄은 JSON.parse에서 걸러진다
}

const parse = (l) => {
  try {
    return JSON.parse(l);
  } catch {
    return null;
  }
};

// 제목: 끝부분의 마지막 ai-title, 없으면 앞부분의 첫 사람 요청 앞 40자
function titleOf(file, size) {
  const found = peek(file, size, true).filter((l) => l.includes('"ai-title"')).map(parse).filter((r) => typeof r?.aiTitle === 'string');
  if (found.length) return found.at(-1).aiTitle;
  for (const l of peek(file, size, false)) {
    const r = parse(l);
    const text = r && typeof r === 'object' ? humanText(r) : null;
    if (text) return cut(text, 40);
  }
  return '(제목 없음)';
}

function newestMtime(file, mtime) {
  const sub = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  let m = mtime;
  try {
    for (const f of fs.readdirSync(sub)) m = Math.max(m, fs.statSync(path.join(sub, f)).mtimeMs);
  } catch {
    // 하위 에이전트 없음
  }
  return m;
}

function listSessions(root, now = Date.now()) {
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return null; // 기록 폴더 없음
  }
  const out = [];
  for (const p of projects) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(root, p.name)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(root, p.name, f);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size === 0) continue;
      let c = titles.get(file);
      if (!c || c.mtime !== st.mtimeMs) {
        c = { mtime: st.mtimeMs, title: titleOf(file, st.size) };
        titles.set(file, c);
      }
      const mtime = newestMtime(file, st.mtimeMs);
      out.push({ id: `${p.name}/${f.slice(0, -'.jsonl'.length)}`, project: p.name, title: c.title, mtime, size: st.size, live: now - mtime < LIVE_MS });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const ID = /^([\w.-]+)\/([\w.-]+)$/;

function resolveSession(root, id) {
  const m = ID.exec(String(id ?? ''));
  if (!m || m[1].includes('..') || m[2].includes('..')) return null;
  const base = path.resolve(root);
  const file = path.resolve(base, m[1], `${m[2]}.jsonl`);
  if (!file.startsWith(base + path.sep)) return null;
  return fs.existsSync(file) ? file : null;
}

module.exports = { listSessions, resolveSession, LIVE_MS };
