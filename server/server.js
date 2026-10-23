// claude-office 서버: 세션 목록, 세션 단계 SSE, 단계 상세, 화면 파일. ~/.claude는 읽기만 한다.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listSessions, resolveSession } = require('./sessions');
const { createReader: defaultReader } = require('./tail');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body = '', type = 'text/plain; charset=utf-8') {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
const sse = (msg) => `data: ${JSON.stringify(msg)}\n\n`;

function createOfficeServer({
  root = path.join(os.homedir(), '.claude', 'projects'),
  contextLimit = 200000,
  pollMs = 1000,
  publicDir = path.join(__dirname, '..', 'public'),
  createReader = defaultReader, // 테스트에서 바꿔 끼운다
} = {}) {
  const open = new Map(); // 파일 → { reader, clients, gone } (보는 화면이 있는 세션만)

  // 늘어난 줄을 읽어 그 세션을 보는 화면들에 보낸다. 읽다가 에러(파일이 지워지는 중 등)가 나면 이번 틱만 건너뛴다
  function tick(entry) {
    let polled;
    try {
      polled = entry.reader.poll();
    } catch (err) {
      if (!entry.failed) console.error('기록 읽기 실패:', err.message);
      entry.failed = true;
      return false;
    }
    entry.failed = false;
    const { steps, agents, gone } = polled;
    if (gone) {
      if (!entry.gone) {
        entry.gone = true;
        for (const c of entry.clients) c.write(sse({ gone: true }));
      }
      return true;
    }
    if (steps.length || agents.length) {
      const msg = sse({ steps, agents });
      for (const c of entry.clients) c.write(msg);
    }
    return true;
  }

  function stream(res, query) {
    const id = query.get('session');
    const file = resolveSession(root, id);
    if (!file) return send(res, 404, 'not found');
    let entry = open.get(file);
    if (!entry) {
      entry = { reader: createReader(file), clients: new Set(), gone: false };
      open.set(file, entry);
    }
    // 이미 보던 화면들에 밀린 것부터 보내고, 새 화면에는 전부. 처음 읽기부터 실패하면 500
    if (!tick(entry) && entry.clients.size === 0) {
      open.delete(file);
      return send(res, 500, 'error');
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const all = entry.reader.all();
    res.write(sse({ session: id, title: entry.reader.title, contextLimit, steps: all.steps, agents: all.agents, gone: entry.gone }));
    entry.clients.add(res);
    res.on('close', () => {
      entry.clients.delete(res);
      if (entry.clients.size === 0 && open.get(file) === entry) open.delete(file);
    });
  }

  function step(res, query) {
    const file = resolveSession(root, query.get('session'));
    if (!file) return send(res, 404, 'not found');
    let reader = open.get(file)?.reader;
    if (!reader) {
      reader = createReader(file);
      reader.poll();
    }
    const d = reader.detail(query.get('step') ?? '');
    return d ? json(res, 200, d) : send(res, 404, 'not found');
  }

  function serveFile(pathname, res) {
    const file = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);
    const type = TYPES[path.extname(file)];
    if (!file.startsWith(publicDir + path.sep) || !type) return send(res, 404, 'not found');
    fs.readFile(file, (err, data) => (err ? send(res, 404, 'not found') : send(res, 200, data, type)));
  }

  const server = http.createServer((req, res) => {
    let pathname, query;
    try {
      ({ pathname, searchParams: query } = new URL(req.url, 'http://x'));
    } catch {
      return send(res, 400, 'bad url');
    }
    // 다른 사이트가 자기 도메인을 127.0.0.1로 돌려(DNS 리바인딩) 기록을 읽지 못하게 Host를 본다
    const port = server.address()?.port;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return send(res, 403, 'forbidden');
    if (req.method !== 'GET') return send(res, 404, 'not found');
    try {
      if (pathname === '/sessions') {
        const sessions = listSessions(root);
        return json(res, 200, { root, found: sessions !== null, sessions: sessions ?? [] });
      }
      if (pathname === '/stream') return stream(res, query);
      if (pathname === '/step') return step(res, query);
    } catch (err) {
      console.error('요청 처리 실패:', err.message);
      return send(res, 500, 'error'); // 서버는 죽지 않는다
    }
    serveFile(pathname, res);
  });

  const timer = setInterval(() => {
    for (const entry of open.values()) tick(entry);
  }, pollMs);
  timer.unref();

  return {
    server,
    close() {
      clearInterval(timer);
      for (const entry of open.values()) for (const c of entry.clients) c.end();
      server.closeAllConnections();
      server.close();
    },
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 7800;
  const opts = {};
  if (process.env.CLAUDE_PROJECTS) opts.root = process.env.CLAUDE_PROJECTS;
  if (Number(process.env.CONTEXT_LIMIT) > 0) opts.contextLimit = Number(process.env.CONTEXT_LIMIT);
  // 기록에 코드·경로·명령 결과가 그대로 있으므로 이 PC에서만 연다
  createOfficeServer(opts).server.listen(port, '127.0.0.1', () => console.log(`claude-office: http://localhost:${port}`));
}

module.exports = { createOfficeServer };
