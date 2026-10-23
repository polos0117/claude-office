// 화면: 세션 고르기 → SSE로 단계 받기 → 시계에 맞춰 사무실·피드 그리기
import { OFFICE_H, OFFICE_W, ROOMS, charLayers, drawOffice, roomRect, spot } from './art.mjs';
import { bubbleOf, fmtDur, markers, sceneAt, timeline } from './scene.mjs';

const $ = (id) => document.getElementById(id);
const MAX_FEED = 300;  // ponytail: 피드는 최근 300줄만 그린다
const RENDER_MS = 100; // 장면은 0.1초마다(데이터가 바뀌면 바로)
const mini = new URLSearchParams(location.search).has('mini'); // 여러 세션 보기의 칸 하나: 사무실만, 늘 마지막 순간

let current = null;     // 보고 있는 세션 id
let es = null;
let steps = new Map();  // id → 단계
let agents = new Map(); // id → 인턴
let sorted = [];        // t 순 단계
let tl = timeline([]);
let contextLimit = 200000;
let gone = false;
let mode = 'pause';     // 'live' | 'play' | 'pause'
let speed = 8;
let v = 0;              // 재생 시각(빈 시간 줄인 것)
let dragging = false;
let version = 0;        // 받은 데이터가 바뀔 때마다 +1
let detailId = null;

const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8);
const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// ---- 사무실 ----

const canvas = $('room');
canvas.width = OFFICE_W;
canvas.height = OFFICE_H;
Object.assign($('office').style, { width: `${OFFICE_W}px`, height: `${OFFICE_H}px` });
document.querySelector('aside').style.height = `${OFFICE_H}px`; // 피드 칸을 사무실 높이에 맞춘다
if (mini) {
  document.body.classList.add('mini');
  const fit = () => ($('office').style.zoom = String(innerWidth / OFFICE_W));
  addEventListener('resize', fit);
  fit();
  document.body.onclick = () => (top.location.href = `/?session=${encodeURIComponent(current)}`);
}
const sheet = new Image();
sheet.onload = () => drawOffice(canvas.getContext('2d'), sheet);
sheet.src = 'art/indoor.png';

const rooms = {}; // place → { el, count }
for (const [place, room] of Object.entries(ROOMS)) {
  const r = roomRect(place);
  const el = document.createElement('div');
  el.className = 'room-hit';
  el.dataset.place = place;
  Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  const label = document.createElement('span');
  label.className = 'room-label';
  label.textContent = `${room.name} · ${room.tools}`;
  const count = document.createElement('span');
  count.className = 'room-count';
  count.textContent = '0';
  el.append(label, count);
  // 방을 누르면 지금까지 그 방에서 한 마지막 일의 상세
  el.onclick = () => {
    const last = sceneAt(sorted, [], clockNow()).feed.findLast((s) => s.place === place);
    if (last) showDetail(last.id);
  };
  $('office').append(el);
  rooms[place] = { el, count };
}

const chars = new Map(); // who → 캐릭터 요소
function charEl(who, kind) {
  let el = chars.get(who);
  if (el) return el;
  el = document.createElement('div');
  el.className = `char ${kind}`;
  for (const bg of charLayers(kind)) {
    const i = document.createElement('i');
    i.style.background = bg;
    el.append(i);
  }
  const bubble = document.createElement('span');
  bubble.className = 'bubble';
  const bang = document.createElement('span');
  bang.className = 'bang';
  bang.textContent = '❗';
  el.append(bubble, bang);
  if (kind === 'staff') {
    const gauge = document.createElement('span');
    gauge.className = 'gauge';
    gauge.append(document.createElement('i'));
    el.append(gauge);
  }
  $('office').append(el);
  chars.set(who, el);
  return el;
}

function put(el, where, i, bubble, err) {
  const p = spot(where, i);
  const left = `${p.x}px`;
  const top = `${p.y}px`;
  if (el.style.left !== left || el.style.top !== top) {
    el.classList.add('moving');
    clearTimeout(el.moveTimer);
    el.moveTimer = setTimeout(() => el.classList.remove('moving'), 500);
    el.style.left = left;
    el.style.top = top;
  }
  const b = el.querySelector('.bubble');
  if (b.textContent !== (bubble ?? '')) b.textContent = bubble ?? '';
  b.hidden = !bubble;
  el.querySelector('.bang').hidden = !err;
}

// ---- 장면 ----

function clockNow() {
  return mode === 'live' ? Math.max(Date.now(), tl.end) : tl.toT(v);
}

function render(clock) {
  const sc = sceneAt(sorted, [...agents.values()], clock, contextLimit);
  const taken = {}; // 방마다 몇 명째인지(겹치지 않게)
  const slot = (where) => (taken[where] = (taken[where] ?? -1) + 1);
  const staff = charEl('main', 'staff');
  put(staff, sc.staff.place, slot(sc.staff.place), sc.staff.bubble, sc.staff.err);
  const pct = Math.min(100, (sc.ctx.used / sc.ctx.limit) * 100);
  const g = staff.querySelector('.gauge i');
  g.style.width = `${pct}%`;
  g.style.background = pct > 90 ? 'var(--err)' : pct > 70 ? 'var(--warn)' : 'var(--good)';
  staff.querySelector('.gauge').title = `문맥(추정) ${fmtK(sc.ctx.used)} / ${fmtK(sc.ctx.limit)}`;
  const here = new Set(['main']);
  for (const it of sc.interns) {
    here.add(it.id);
    const el = charEl(it.id, 'intern');
    el.hidden = false;
    put(el, it.place, slot(it.place), it.bubble, it.err);
  }
  for (const [who, el] of chars) if (!here.has(who)) el.hidden = true;
  for (const [place, r] of Object.entries(rooms)) {
    r.count.textContent = String(sc.counts[place] ?? 0);
    r.el.classList.toggle('active', sc.active.includes(place));
  }
  showFeed(sc.feed, clock);
  showSummary(sc, clock);
}

let feedKey = '';
function showFeed(feed, clock) {
  const done = feed.filter((s) => s.end != null && s.end <= clock).length;
  const key = `${current}:${version}:${feed.length}:${done}`;
  if (key === feedKey) return;
  feedKey = key;
  const box = $('feed');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
  box.replaceChildren(...feed.slice(-MAX_FEED).map((s) => {
    const d = document.createElement('div');
    if (s.who !== 'main') d.classList.add('sub');
    else if (s.kind === 'user') d.classList.add('user');
    const ended = s.end != null && s.end <= clock;
    const failed = ended && s.ok === false;
    if (failed) d.classList.add('err');
    const dur = ended ? ` (${fmtDur(s.end - s.t)})` : s.kind === 'tool' ? ' …' : '';
    d.textContent = `${hhmmss(s.t)} ${failed ? '✗ ' : ''}${bubbleOf(s)}${dur}`;
    d.title = d.textContent;
    d.onclick = () => showDetail(s.id);
    return d;
  }));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function showSummary(sc, clock) {
  if (!sorted.length) {
    $('summary').textContent = '';
    return;
  }
  const tools = sc.feed.filter((s) => s.kind === 'tool');
  const errs = tools.filter((s) => s.ok === false && s.end <= clock).length;
  const out = sc.feed.reduce((n, s) => n + (s.tokens?.out ?? 0), 0);
  const interns = [...agents.values()].filter((a) => a.start != null && a.start <= clock).length;
  $('summary').textContent = `시작 ${hhmmss(tl.start)} · 경과 ${fmtDur(Math.max(0, clock - tl.start))} · 도구 ${tools.length}회 · 에러 ${errs} · 출력 토큰 ${fmtK(out)} · 인턴 ${interns}`;
}

function showMarks() {
  $('marks').replaceChildren(...markers(sorted, [...agents.values()]).map((m) => {
    const i = document.createElement('i');
    i.className = `m-${m.kind}`;
    i.style.left = `${tl.total ? (tl.toV(m.t) / tl.total) * 100 : 0}%`;
    return i;
  }));
}

// ---- 상세 ----

function showFeedPanel() {
  detailId = null;
  $('feed').hidden = false;
  $('detail').hidden = true;
  $('back').hidden = true;
  $('sidetitle').textContent = '활동';
}
$('back').onclick = showFeedPanel;

async function showDetail(id) {
  detailId = id;
  $('feed').hidden = true;
  $('detail').hidden = false;
  $('back').hidden = false;
  $('sidetitle').textContent = '상세';
  $('detail').textContent = '불러오는 중…';
  const res = await fetch(`/step?session=${encodeURIComponent(current)}&step=${encodeURIComponent(id)}`).catch(() => null);
  if (detailId !== id) return;
  if (!res?.ok) {
    $('detail').textContent = '상세를 불러오지 못했습니다.';
    return;
  }
  const d = await res.json();
  if (detailId !== id) return;
  const s = d.step;
  const rows = [
    ['종류', s.kind === 'tool' ? `${s.tool} (${ROOMS[s.place]?.name ?? s.place})` : bubbleOf(s)],
    ['시각', `${hhmmss(s.t)}${s.end != null ? ` → ${hhmmss(s.end)} (${fmtDur(s.end - s.t)})` : ''}`],
    s.kind === 'tool' ? ['결과', s.ok === false ? '실패' : s.ok ? '성공' : '진행 중'] : null,
    s.tokens ? ['토큰', `입력 ${s.tokens.in} · 캐시 ${s.tokens.cache} · 출력 ${s.tokens.out}`] : null,
    s.thinkMs != null ? ['생각', fmtDur(s.thinkMs)] : null,
    s.skill ? ['스킬', s.skill] : null,
    s.who !== 'main' ? ['누가', `인턴: ${agents.get(s.who)?.role ?? s.who}`] : null,
  ].filter(Boolean);
  const box = $('detail');
  box.replaceChildren();
  for (const [k, val] of rows) {
    const p = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = `${k} `;
    p.append(b, val);
    box.append(p);
  }
  for (const [k, part] of [['입력', d.input], ['결과', d.result]]) {
    if (!part) continue;
    const h = document.createElement('h3');
    h.textContent = part.truncated ? `${k} (앞 20KB만)` : k;
    const pre = document.createElement('pre');
    pre.textContent = part.text;
    box.append(h, pre);
  }
}

// ---- 재생 ----

function setMode(m) {
  mode = m;
  $('toggle').textContent = m === 'play' ? '❚❚' : '▶';
  $('live').classList.toggle('on', m === 'live');
  conn();
}

function conn(err) {
  const el = $('conn');
  el.textContent = err ?? (gone ? '기록이 끊김' : mode === 'live' ? '● 실시간' : '재생');
  el.className = err || gone ? '' : mode === 'live' ? 'live' : 'replay';
}

$('toggle').onclick = () => {
  if (mode === 'play') return setMode('pause');
  if (mode === 'live' || v >= tl.total) v = 0;
  setMode('play');
};
for (const b of document.querySelectorAll('[data-speed]')) {
  b.classList.toggle('on', Number(b.dataset.speed) === speed);
  b.onclick = () => {
    speed = Number(b.dataset.speed);
    for (const x of document.querySelectorAll('[data-speed]')) x.classList.toggle('on', x === b);
  };
}
$('pos').oninput = () => {
  dragging = true;
  v = (Number($('pos').value) / 1000) * tl.total;
  if (mode !== 'pause') setMode('pause');
};
$('pos').onchange = () => (dragging = false);
$('live').onclick = () => setMode('live');

let lastFrame = 0;
let lastRender = 0;
let renderedVersion = -1;
function frame(ts) {
  const dt = lastFrame ? ts - lastFrame : 0;
  lastFrame = ts;
  if (mode === 'play') {
    v += dt * speed;
    if (v >= tl.total) {
      v = tl.total;
      setMode('pause');
    }
  }
  if (mode === 'live' || mini) v = tl.total;
  if (ts - lastRender >= RENDER_MS || version !== renderedVersion || dragging) {
    lastRender = ts;
    renderedVersion = version;
    const clock = clockNow();
    render(clock);
    $('clock').textContent = sorted.length ? hhmmss(clock) : '';
    if (!dragging) $('pos').value = String(tl.total ? Math.round((v / tl.total) * 1000) : 1000);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- 세션 ----

function open(id, live) {
  es?.close();
  current = id;
  steps = new Map();
  agents = new Map();
  sorted = [];
  tl = timeline([]);
  gone = false;
  v = 0;
  version++;
  for (const el of chars.values()) el.remove();
  chars.clear();
  showFeedPanel();
  setMode(live ? 'live' : 'pause');
  es = new EventSource(`/stream?session=${encodeURIComponent(id)}`);
  es.onopen = () => conn();
  es.onerror = () => conn('연결 끊김 — 다시 연결하는 중');
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.session) {
      // 첫 메시지(다시 연결 포함)는 전부를 담고 있다
      steps = new Map();
      agents = new Map();
      if (msg.contextLimit > 0) contextLimit = msg.contextLimit;
    }
    for (const s of msg.steps ?? []) steps.set(s.id, s);
    for (const a of msg.agents ?? []) agents.set(a.id, a);
    if (msg.gone) gone = true;
    sorted = [...steps.values()].sort((a, b) => a.t - b.t);
    tl = timeline(sorted);
    version++;
    showMarks();
    conn();
  };
}

async function loadSessions() {
  const data = await (await fetch('/sessions')).json();
  if (!data.found) {
    $('empty').hidden = false;
    $('empty').textContent = `클로드 코드 기록을 찾지 못함 (${data.root})`;
    return;
  }
  const sel = $('sessions');
  sel.replaceChildren(...data.sessions.map((s) => {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.live ? '● ' : ''}${s.project} · ${s.title}`;
    o.dataset.live = s.live ? '1' : '';
    return o;
  }));
  const asked = new URLSearchParams(location.search).get('session');
  const pick = data.sessions.find((s) => s.id === asked) ?? data.sessions.find((s) => s.live) ?? data.sessions[0];
  if (!pick) {
    $('empty').hidden = false;
    $('empty').textContent = '세션 기록이 없습니다.';
    return;
  }
  sel.value = pick.id;
  open(pick.id, pick.live);
}
$('sessions').onchange = (e) => open(e.target.value, e.target.selectedOptions[0]?.dataset.live === '1');
loadSessions();
