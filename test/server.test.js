const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOfficeServer } = require('../server/server');

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'office-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
async function start(t, root, opts = {}) {
  const o = createOfficeServer({ root, pollMs: 100, ...opts });
  await new Promise((r) => o.server.listen(0, '127.0.0.1', r));
  t.after(() => o.close());
  return `http://127.0.0.1:${o.server.address().port}`;
}
// SSE 메시지 하나씩. 큰 메시지는 여러 조각으로 오므로 빈 줄까지 모은다
function sseReader(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  return async () => {
    while (!buf.includes('\n\n')) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buf += dec.decode(value, { stream: true });
    }
    const i = buf.indexOf('\n\n');
    const msg = buf.slice(0, i);
    buf = buf.slice(i + 2);
    return JSON.parse(msg.replace(/^data: /, ''));
  };
}
let u = 0;
const at = (s) => new Date(Date.UTC(2026, 9, 23, 1, 0, s)).toISOString();
const rec = (o) => `${JSON.stringify({ uuid: `u${u++}`, ...o })}\n`;
const tool = (sec, id, name, input) => rec({ type: 'assistant', timestamp: at(sec), requestId: `r${u}`, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (sec, id, content) => rec({ type: 'user', timestamp: at(sec), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const human = (sec, text) => rec({ type: 'user', timestamp: at(sec), message: { role: 'user', content: text } });

function session(t, lines) {
  const root = tmp(t);
  fs.mkdirSync(path.join(root, 'C--p'));
  const file = path.join(root, 'C--p', 's1.jsonl');
  fs.writeFileSync(file, lines);
  return { root, file };
}

test('/sessions: 목록과 found, 기록 폴더가 없으면 found:false', async (t) => {
  const { root } = session(t, human(0, '안녕'));
  const d = await (await fetch(`${await start(t, root)}/sessions`)).json();
  assert.equal(d.found, true);
  assert.deepEqual(d.sessions.map((s) => [s.id, s.title, s.live]), [['C--p/s1', '안녕', true]]);
  const d2 = await (await fetch(`${await start(t, path.join(root, 'nope'))}/sessions`)).json();
  assert.equal(d2.found, false);
  assert.deepEqual(d2.sessions, []);
});

test('/stream: 첫 메시지에 전부, 줄이 붙으면 결과가 온 단계·새 단계만', async (t) => {
  const { root, file } = session(t, human(0, '해줘') + `${JSON.stringify({ type: 'ai-title', aiTitle: '제목' })}\n` + tool(1, 't1', 'Edit', { file_path: 'a.js' }));
  const base = await start(t, root, { contextLimit: 1000 });
  const ac = new AbortController();
  t.after(() => ac.abort());
  const res = await fetch(`${base}/stream?session=C--p/s1`, { signal: ac.signal });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const next = sseReader(res);
  const first = await next();
  assert.equal(first.session, 'C--p/s1');
  assert.equal(first.title, '제목');
  assert.equal(first.contextLimit, 1000);
  assert.equal(first.gone, false);
  assert.deepEqual(first.steps.map((s) => s.kind), ['user', 'tool']);
  assert.deepEqual(first.agents, []);
  fs.appendFileSync(file, result(2, 't1', 'ok') + tool(3, 't2', 'Bash', { command: 'npm test' }));
  const msg = await next();
  assert.deepEqual(msg.steps.map((s) => [s.id, s.end !== null]), [[first.steps[1].id, true], ['main:2', false]]);
});

test('/step: 입력·결과(20KB에서 자름), 없는 단계·세션은 404', async (t) => {
  const { root } = session(t, tool(0, 't1', 'Bash', { command: 'cat big' }) + result(1, 't1', 'z'.repeat(50000)));
  const base = await start(t, root);
  const d = await (await fetch(`${base}/step?session=C--p/s1&step=main:0`)).json();
  assert.equal(d.step.tool, 'Bash');
  assert.match(d.input.text, /cat big/);
  assert.equal(d.result.text.length, 20 * 1024);
  assert.equal(d.result.truncated, true);
  assert.equal((await fetch(`${base}/step?session=C--p/s1&step=main:99`)).status, 404);
  assert.equal((await fetch(`${base}/step?session=C--p/nope&step=main:0`)).status, 404);
});

test('세션 값이 이상하면 404(기록 폴더 밖으로 못 나간다)', async (t) => {
  const { root } = session(t, human(0, '안녕'));
  fs.writeFileSync(path.join(root, 'secret.jsonl'), human(0, '비밀'));
  const base = await start(t, root);
  for (const q of ['session=..%2Fsecret', 'session=C--p%2F..%2F..%2Fsecret', 'session=', '', 'session=C--p/nope', 'session=C--p/..'])
    assert.equal((await fetch(`${base}/stream?${q}`)).status, 404, q);
});

test('화면 파일은 public 안의 알려진 종류만, GET만', async (t) => {
  const { root } = session(t, human(0, '안녕'));
  const pub = tmp(t);
  fs.writeFileSync(path.join(pub, 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(pub, 'a.exe'), 'x');
  const base = await start(t, root, { publicDir: pub });
  const ok = await fetch(`${base}/`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /text\/html/);
  for (const p of ['/a.exe', '/nope.html', '/%2e%2e/package.json', '/..%2fserver%2fserver.js'])
    assert.equal((await fetch(base + p)).status, 404, p);
  assert.equal((await fetch(`${base}/sessions`, { method: 'POST' })).status, 404);
});

test('서버는 이 PC(127.0.0.1)에서만 접속을 받는다', async (t) => {
  const { spawn } = require('node:child_process');
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal);
  if (!lan) return t.skip('외부 네트워크 주소가 없음');
  const port = 7890 + Math.floor(Math.random() * 100);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(port), CLAUDE_PROJECTS: tmp(t) },
  });
  t.after(() => child.kill());
  await new Promise((r) => child.stdout.once('data', r));
  assert.equal((await fetch(`http://127.0.0.1:${port}/sessions`)).status, 200);
  await assert.rejects(fetch(`http://${lan.address}:${port}/sessions`));
});
