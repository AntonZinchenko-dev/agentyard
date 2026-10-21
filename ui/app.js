// Интерфейс AgentYard: без сборки и без библиотек.
// Источник правды — сервер: живые события приходят через EventSource, история — из папки прогона.
'use strict';

const TOKEN = new URLSearchParams(location.search).get('t') || '';
const desktop = window.ayDesktop || null; // есть только в Electron-оболочке

const STATUS_RU = { waiting: 'ждёт очереди', ready: 'готова к работе', running: 'в работе', checking: 'проверки', review: 'ревью', done: 'готово', human: 'ждёт тебя' };
const STATUS_ORDER = ['running', 'checking', 'review', 'ready', 'waiting', 'done', 'human'];
const ROLE_RU = { goalcheck: 'Приёмка', coder: 'Кодер', tester: 'Тестировщик', reviewer: 'Ревьюер', analyst: 'Аналитик', planner: 'Планировщик', scout: 'Разведчик', reporter: 'Репортёр' };
const PHASE_RU = {
  team: 'Собираю бригаду моделей',
  map: 'Читаю структуру проекта',
  planning: 'Планировщик составляет план',
  approval: 'Ждёт утверждения плана',
  running: 'Идёт работа',
  verifying: 'Финальная проверка: полный набор тестов',
  stopping: 'Останавливаю',
  finished: 'Готово',
};
const LADDER_RU = { 0: '', 1: 'повтор формата', 2: 'повтор с ошибкой', 3: 'аналитик', 4: 'дробление', 5: 'модель сильнее', 6: 'человек' };

const S = {
  view: 'run',
  run: null, // { runId, repo, goal, mock }
  phase: null,
  tasks: [],
  active: null,
  lines: [],
  lineKeys: new Set(),
  plan: null,
  result: null,
  error: null,
  team: [],
  selected: null,
  viewingHistory: null, // { repo, id } — доска показывает прошлый прогон
  transcripts: [],
  humanNote: {}, // taskId → { text, ok } — что происходит с ручной правкой
  handoff: {}, // taskId → { dir, files, watching } — открытая ручная копия
  appliedNow: {}, // runId → true/false — применили или откатили кнопкой, пока смотрим доску
  activity: {}, // дорожка → { text, taskId, role, model, since } — что происходит прямо сейчас
};

// ---------- помощники ----------

const $ = (id) => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-ay-token': TOKEN, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}
function remember(key, value) {
  try { localStorage.setItem(`ay.${key}`, value); } catch { /* приватный режим */ }
}
function recall(key) {
  try { return localStorage.getItem(`ay.${key}`) || ''; } catch { return ''; }
}
function fmtSec(s) {
  if (s == null) return '—';
  return s < 90 ? `${Math.round(s)} с` : `${(s / 60).toFixed(1)} мин`;
}
/** id прогона — время старта по UTC; показываем по местному времени. */
function fmtRunId(id) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(id);
  if (!m) return id;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------- навигация ----------

function show(view) {
  S.view = view;
  for (const b of document.querySelectorAll('.nav')) b.classList.toggle('on', b.dataset.view === view);
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${view}`;
  if (view === 'models') loadModels();
  if (view === 'history') loadRuns();
  if (view === 'integrations') loadIntegrations();
  if (view === 'board') renderBoard();
}
for (const b of document.querySelectorAll('.nav')) b.addEventListener('click', () => show(b.dataset.view));

// ---------- верхняя строка ----------

function renderTop() {
  const ph = $('phase');
  ph.className = 'phase';
  let text = 'Готов к запуску';
  if (S.viewingHistory) text = `Прошлый прогон ${fmtRunId(S.viewingHistory.id)}`;
  else if (S.error) { text = 'Прогон остановлен'; ph.classList.add('bad'); }
  else if (S.result) {
    const inProject = isAppliedLive();
    text = inProject ? 'Готово, результат в проекте' : S.result.human.length ? `Готово, ${S.result.human.length} ждут тебя` : 'Готово, в проект не применено';
    ph.classList.add(inProject ? 'ok' : 'bad');
  }
  else if (S.phase === 'approval') { text = PHASE_RU.approval; ph.classList.add('ask'); }
  else if (S.stopping) { text = `Останавливаю: ${S.stopping}`; ph.classList.add('ask'); }
  else if (S.phase) {
    text = PHASE_RU[S.phase] || S.phase;
    ph.classList.add('live');
    const g = S.activity.gpu;
    if (g) text = `${g.role ? `${ROLE_RU[g.role] || g.role}${g.taskId ? ` ${taskNo(g.taskId)}` : ''}: ` : ''}${g.text}`;
    else if (S.phase === 'running' && S.active) text = `${ROLE_RU[S.active.role] || S.active.role} ${taskNo(S.active.taskId)}, ${S.active.model}`;
  }
  $('phaseText').textContent = text;
  const goal = S.viewingHistory ? S.viewingHistory.goal : S.run && S.run.goal;
  $('topGoal').textContent = goal ? (goal === 'fix-tests' ? 'Цель: починить падающие тесты' : `Цель: ${goal}`) : '';
  $('team').textContent = S.team.length ? S.team.join(' + ') : '';
  const live = S.run && !S.result && !S.error && !S.viewingHistory;
  const runErr = $('runErr');
  if (S.error && !S.viewingHistory) {
    runErr.textContent = `Прогон остановлен. ${S.error}`;
    runErr.hidden = false;
  } else if (runErr.dataset.kind !== 'start') runErr.hidden = true;
  $('stopBtn').hidden = !live;
  // «Стоп» нажат: кнопка показывает, что остановка идёт (запрос к модели оборван, проверки доделываются)
  $('stopBtn').disabled = !!(live && S.stopping);
  if (live && S.stopping) { delete $('stopBtn').dataset.armed; $('stopBtn').textContent = 'Останавливаю…'; }
  else if (!$('stopBtn').dataset.armed) $('stopBtn').textContent = 'Стоп';
  $('startBtn').disabled = !!live;
}

$('stopBtn').addEventListener('click', async () => {
  if (S.stopping) return;
  if (!confirmInline($('stopBtn'), 'Точно остановить?')) return;
  try {
    await api('/api/stop', {});
    S.stopping = S.stopping || 'обрываю запрос к модели и доделываю идущие проверки';
    renderTop();
  } catch (e) { alertBox(e.message); }
});

/** Справка по ошибке: ссылки, по которым ходила программа, и сам текст (свёрнут). */
function refBlock(text) {
  const urls = [...new Set(text.match(/https?:\/\/[^\s)]+/g) || [])].slice(0, 6);
  return h('div', { class: 'small' },
    urls.length ? h('ul', { class: 'small' }, urls.map((u) => h('li', {}, h('a', { href: u, target: '_blank', rel: 'noopener' }, u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 90))))) : h('div', { class: 'muted' }, 'Только объявления типов из установленных библиотек.'),
    h('details', {}, h('summary', {}, 'текст справки'), h('pre', {}, text)));
}

/** Подтверждение без системного окна: второй щелчок в течение 3 секунд. */
function confirmInline(btn, text) {
  if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; return true; }
  btn.dataset.label = btn.textContent;
  btn.dataset.armed = '1';
  btn.textContent = text;
  setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; } }, 3000);
  return false;
}

// ---------- запуск ----------

const repoInp = $('repo');
const goalInp = $('goal');
repoInp.value = recall('repo');
goalInp.value = recall('goal');
// учебная модель вместо Ollama — только для разработки самого AgentYard (адрес с ?mock)
const MOCK = new URLSearchParams(location.search).has('mock');
let repoTimer = null;
repoInp.addEventListener('input', () => { clearTimeout(repoTimer); repoTimer = setTimeout(checkRepo, 400); });
goalInp.addEventListener('input', () => remember('goal', goalInp.value));
let INFO = { appDir: '', shopGoal: '' };
let repoState = null;
function setGoal(g) { goalInp.value = g; remember('goal', g); renderGoalInfo(); }
goalInp.addEventListener('input', renderGoalInfo);

/** Подсказка, если цель не подходит к выбранной папке. */
/** Цель похожа на вставленный текст ошибки или журнала, а не на задачу. */
function looksLikeErrorText(goal) {
  return /Ollama \/api\/|"error"\s*:|exit status 0x|llama-server|CUDA error|не загрузилась:|^\d\d:\d\d:\d\d\s|Traceback|at .+\(.+:\d+:\d+\)/.test(goal);
}

function renderGoalInfo() {
  const info = $('goalInfo');
  info.replaceChildren();
  info.className = 'hint';
  const goal = goalInp.value.trim();
  if (looksLikeErrorText(goal)) {
    info.className = 'hint bad';
    info.textContent = 'Похоже, в цель вставлен текст ошибки или журнала, а не задача. Агенты будут «чинить» этот текст. Опиши, что сделать в проекте.';
    return;
  }
  if (!goal) {
    info.textContent = 'Опиши результат своими словами: что должно измениться или что получить.';
  } else if (/кратк\S* содерж|саммари|summary|перескаж|выжимк|конспект|извлеки|вытащи|выпиши|распарс|парсинг|в таблиц|в json|в csv|переведи/i.test(goal)) {
    info.textContent = 'Задача с документами или данными: исходные файлы программа прочитает сама (docx, pdf, xlsx, html, csv, json), результат появится в папке out/.';
  } else if (goal === 'fix-tests') {
    info.textContent = 'Найти падающие тесты и починить код. Если все тесты проходят, делать будет нечего.';
  }
}

if (desktop && desktop.pickFolder) {
  $('pickBtn').hidden = false;
  $('pickBtn').addEventListener('click', async () => {
    const dir = await desktop.pickFolder();
    if (dir) { repoInp.value = dir; checkRepo(); }
  });
}

async function checkRepo() {
  const p = repoInp.value.trim();
  const info = $('repoInfo');
  info.className = 'hint';
  if (!p) { repoState = null; renderGoalInfo(); info.textContent = 'Папка с кодом, документами или данными. Работа идёт в отдельной ветке, твои файлы не меняются, пока ты не применишь результат.'; return; }
  remember('repo', p);
  try {
    const r = await api(`/api/repo?path=${encodeURIComponent(p)}`);
    repoState = r;
    renderGoalInfo();
    if (!r.exists) { info.textContent = 'Такой папки нет.'; info.classList.add('bad'); return; }
    // готовность проекта: что конвейер сможет проверить
    const icon = { ok: '✓', warn: '!', block: '✕' };
    info.replaceChildren(...r.readiness.map((it) => h('div', { class: `ready ready-${it.level}` },
      h('span', { class: 'ready-i' }, icon[it.level]),
      h('span', {}, it.text),
      it.suggest ? h('button', { class: 'btn', onclick: () => { repoInp.value = it.suggest; checkRepo(); } }, 'Взять корень') : '',
    )));
    if (r.runs.length) info.append(h('div', { class: 'ready ready-ok' }, h('span', { class: 'ready-i' }, '·'), `Прогонов в истории: ${r.runs.length}.`));
    const broken = r.runs.find((x) => x.resumable);
    if (broken) {
      info.append(h('div', { class: 'ready ready-warn' }, h('span', { class: 'ready-i' }, '!'),
        `Прогон «${(broken.goal || '').slice(0, 60)}» прервался на середине (окно закрылось или компьютер уснул).`,
        h('button', { class: 'btn', onclick: () => resumeRun(r.path, broken.id) }, 'Продолжить')));
    }
    if (r.dirty) info.append(h('div', { class: 'ready ready-warn' }, h('span', { class: 'ready-i' }, '!'), 'Есть незакоммиченные изменения: конвейер возьмёт за основу последний коммит.'));
  } catch (e) { info.textContent = e.message; info.classList.add('bad'); }
}

$('startBtn').addEventListener('click', async () => {
  const err = $('runErr');
  err.hidden = true;
  err.dataset.kind = '';
  if (looksLikeErrorText(goalInp.value.trim()) && !confirmInline($('startBtn'), 'Цель — текст ошибки. Всё равно?')) {
    renderGoalInfo();
    return;
  }
  try {
    await api('/api/run', {
      repo: repoInp.value.trim(),
      goal: goalInp.value.trim(),
      approve: $('optApprove').value,
      autoApply: $('optAutoApply').checked,
      allowInstall: $('optInstall').checked,
      review: $('optReview').checked,
      offload: $('optOffload').checked,
      mock: MOCK,
      ctx: Number($('optCtx').value) || undefined,
      issue: pendingIssue || undefined,
    });
    pendingIssue = null;
    renderIssueInfo();
    show('board');
  } catch (e) {
    err.textContent = e.message;
    err.dataset.kind = 'start';
    err.hidden = false;
  }
});

// ---------- живые события ----------

function resetRun(run) {
  // продолжение того же прогона (ручная правка) — оставляем выбранную задачу и заметки
  const same = S.run && run && S.run.runId === run.runId;
  Object.assign(S, { run, phase: null, tasks: [], active: null, lines: [], lineKeys: new Set(), plan: null, result: null, error: null, viewingHistory: null, transcripts: [], activity: {}, stopping: null });
  if (!same) Object.assign(S, { selected: null, humanNote: {}, handoff: {} });
  if (run) delete S.appliedNow[run.runId];
}

function apply(e) {
  switch (e.kind) {
    case 'run-begin':
      resetRun({ runId: e.runId, repo: e.repo, goal: e.goal, mock: e.mock });
      break;
    case 'phase':
      S.phase = e.phase;
      if (e.phase === 'stopping') S.stopping = e.detail || 'обрываю запрос к модели и доделываю идущие проверки';
      if (e.team) S.team = e.team;
      if (e.phase !== 'approval') S.plan = null;
      break;
    case 'journal': {
      const key = e.at + e.line;
      if (!S.lineKeys.has(key)) { S.lineKeys.add(key); S.lines.push(e.line); }
      break;
    }
    case 'tasks':
      S.tasks = e.tasks;
      S.active = e.active;
      break;
    case 'plan':
      S.plan = { plan: e.plan, warnings: e.warnings };
      break;
    case 'result':
      S.result = e.result;
      S.plan = null;
      S.activity = {};
      break;
    case 'error':
      S.error = e.message;
      S.plan = null;
      S.activity = {};
      break;
    case 'human':
      S.humanNote[e.taskId] = { text: e.message, ok: e.state !== 'error' };
      if (S.selected === e.taskId) renderDetail();
      break;
    case 'activity':
      if (e.text == null) delete S.activity[e.lane];
      else S.activity[e.lane] = e;
      renderNow();
      renderTop();
      return;
    case 'eval':
      return;
    case 'pull':
      pullState[e.tag] = e.done ? null : e.text;
      if (e.error) pullErrors[e.tag] = e.error;
      if (S.view === 'models') { if (e.done) loadModels(); else renderModels(); }
      return;
  }
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderTop();
    if (S.view === 'board') renderBoard();
  });
}

function connect() {
  const es = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`);
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (S.viewingHistory && e.kind !== 'pull') { S.viewingHistory = null; } // новый живой прогон важнее истории
    apply(e);
    // во время экзамена остаёмся на его вкладке: прогоны идут один за другим сами
    if ((e.kind === 'run-begin' || e.kind === 'plan')) show('board');
    scheduleRender();
  };
  es.onerror = () => { $('sideFoot').textContent = 'Нет связи с сервером… переподключаюсь'; };
  es.onopen = () => { $('sideFoot').textContent = desktop ? 'Окно приложения' : 'Открыто в браузере'; };
}

async function restore() {
  try {
    const cur = await api('/api/current');
    if (!cur) return;
    resetRun({ runId: cur.runId, repo: cur.repo, goal: cur.goal, mock: cur.mock });
    for (const e of cur.events) apply(e);
    if (!cur.finished) show('board');
  } catch { /* сервер только поднялся */ }
}

// ---------- что происходит сейчас ----------

function ago(since) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${String(s % 60).padStart(2, '0')} с`;
}

function renderNow() {
  const box = $('nowBox');
  const live = S.run && !S.result && !S.error && !S.viewingHistory;
  if (!live) { box.hidden = true; return; }
  box.hidden = false;
  const lanes = Object.entries(S.activity).sort(([a], [b]) => (a === 'gpu' ? -1 : b === 'gpu' ? 1 : a.localeCompare(b)));
  const row = (cls, who, text, since) => h('div', { class: `now-row ${cls}` },
    h('span', { class: 'now-dot' }),
    h('span', { class: 'now-who' }, who),
    h('span', { class: 'now-text', title: text }, text),
    since ? h('span', { class: 'now-time' }, ago(since)) : '');
  const rows = lanes.map(([lane, a]) => lane === 'gpu'
    ? row('gpu', [a.role ? ROLE_RU[a.role] || a.role : 'Модель', a.taskId ? ` · ${taskNo(a.taskId)} ${taskTitle(a.taskId)}` : '', a.model ? h('span', { class: 'muted' }, `, ${a.model}`) : ''], a.text, a.since)
    : row('cpu', `Проверки${a.taskId ? ` · ${taskNo(a.taskId)} ${taskTitle(a.taskId)}` : ''}`, a.text, a.since));
  if (!rows.length) rows.push(row('idle', 'Программа', S.phase ? PHASE_RU[S.phase] || S.phase : 'запускается…', null));
  box.replaceChildren(h('div', { class: 'now-title' }, 'Сейчас'), ...rows);
}
setInterval(() => { if (Object.keys(S.activity).length) renderNow(); }, 1000);

// ---------- доска ----------

/** Чей прогон на доске: живой или открытый из истории. */
function boardTarget() {
  if (S.viewingHistory) return { repo: S.viewingHistory.repo, id: S.viewingHistory.id };
  if (S.run) return { repo: S.run.repo, id: S.run.runId };
  return null;
}

function isAppliedLive() {
  if (!S.result || !S.run) return false;
  if (S.run.runId in S.appliedNow) return S.appliedNow[S.run.runId];
  const a = S.result.applied;
  return !!(a && a.ok && a.mode !== 'nothing');
}

/** Этапы: задача стоит на этапе после всех, от кого зависит. */
const seqCmp = (a, b) => (a.seq && b.seq ? (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0) : a.id.localeCompare(b.id, 'ru', { numeric: true }));

/**
 * Дерево работы: этапы плана → задачи → их части (матрёшка); повторы решения образца свёрнуты под ним.
 * Этап — поле stage из плана; у задач без этапа — шаг по зависимостям.
 */
function stageTree(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const leaderOf = (t) => (t.solutionFrom && !t.parent ? byId.get(t.solutionFrom) : null);
  const isReplica = (t) => { const l = leaderOf(t); return !!l && !!t.pool && t.pool === l.pool; };
  const top = tasks.filter((t) => !t.parent && !isReplica(t)).sort(seqCmp);
  const level = new Map();
  const lv = (t, seen = new Set()) => {
    if (level.has(t.id)) return level.get(t.id);
    if (seen.has(t.id)) return 0;
    seen.add(t.id);
    const ds = t.dependsOn.map((d) => byId.get(d)).filter((d) => d && !d.parent).map((d) => lv(d, seen) + 1);
    const v = ds.length ? Math.max(...ds) : 0;
    level.set(t.id, v);
    return v;
  };
  const groups = new Map();
  for (const t of top) {
    const key = t.stage ? `s:${t.stage}` : `l:${lv(t)}`;
    if (!groups.has(key)) groups.set(key, { name: t.stage || '', tasks: [] });
    groups.get(key).tasks.push(t);
  }
  const list = [...groups.values()].sort((a, b) => seqCmp(a.tasks[0], b.tasks[0]));
  list.forEach((g, i) => {
    if (!g.name) g.name = g.tasks.length === 1 ? g.tasks[0].title : `Шаг ${i + 1}`;
  });
  const childrenOf = (id) => tasks.filter((t) => t.parent === id).sort(seqCmp);
  const replicasOf = (id) => tasks.filter((t) => isReplica(t) && t.solutionFrom === id).sort(seqCmp);
  const leaves = (t) => {
    const kids = childrenOf(t.id);
    return [...(kids.length ? kids.flatMap(leaves) : [t]), ...replicasOf(t.id).flatMap(leaves)];
  };
  return { list, childrenOf, replicasOf, leaves };
}

/** Номера задач по дереву: 2.1 — первая задача второго этапа, 2.1.3 — её третья часть. */
let NUM = new Map();
/** Номер задачи для людей (по дереву), а не внутренний id. */
function taskNo(id) {
  if (!NUM.size && S.tasks.length) { const tree = stageTree(S.tasks); tree.list.forEach((g, i) => g.tasks.forEach((t, j) => taskRows(t, `${i + 1}.${j + 1}`, 0, tree))); }
  return NUM.get(id) || id;
}
function taskTitle(id) {
  const t = S.tasks.find((x) => x.id === id);
  return t ? t.title : '';
}

/** Причина «у человека» человеческими словами. */
function whyText(why) {
  return String(why || 'нужно решение человека')
    .replace(/^лестница эскалации пройдена\. Последняя ошибка:/, 'Агенты перепробовали всё: повторы, разбор ошибки, модель посильнее. Последняя ошибка:')
    .replace(/^исчерпан бюджет попыток \((\d+)\)\. Последняя ошибка:/, 'Агенты $1 раз не смогли. Последняя ошибка:');
}

/** Не начатая из-за проваленной задача — для человека это «ждёт очереди», а не «ждёт тебя». */
function isBlocked(t) { return t.status === 'human' && /^не (начата|собрана)/.test(String(t.humanWhy || '')); }
function effStatus(t) { return isBlocked(t) ? 'waiting' : t.status; }

function stageColor(list) {
  list = list.map((t) => ({ ...t, status: effStatus(t) }));
  if (list.some((t) => t.status === 'human')) return 'st-human';
  if (list.some((t) => ['running', 'checking', 'review'].includes(t.status))) return 'st-running';
  if (list.length && list.every((t) => t.status === 'done')) return 'st-done';
  return 'st-waiting';
}

function renderBoard() {
  renderNow();
  renderCounters();
  renderPlanBox();
  renderResultBox();
  const g = $('graph');
  const tasks = S.tasks;
  $('reportBtn').hidden = !reportTarget();
  $('pdfBtn').hidden = !reportTarget();
  g.replaceChildren();
  if (!tasks.length) {
    g.append(h('div', { class: 'empty' }, S.phase === 'planning' ? 'Планировщик составляет план…' : S.plan ? 'План ждёт утверждения — он выше.' : 'Задачи появятся здесь, когда планировщик составит план.'));
  } else {
    const tree = stageTree(tasks);
    NUM = new Map();
    tree.list.forEach((g, i) => {
      const leaves = g.tasks.flatMap(tree.leaves);
      const done = leaves.filter((t) => t.status === 'done').length;
      const rows = [];
      g.tasks.forEach((t, j) => rows.push(...taskRows(t, `${i + 1}.${j + 1}`, 0, tree)));
      $('graph').append(h('section', { class: `stage ${stageColor(leaves)}`, 'aria-label': `Этап ${i + 1}: ${g.name}` },
        h('span', { class: 'stage-node' }, String(i + 1)),
        h('header', { class: 'stage-head' },
          h('h3', { class: 'stage-name' }, g.name),
          h('span', { class: 'stage-progress' }, `${done} из ${leaves.length}`),
          h('span', { class: 'stage-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': leaves.length, 'aria-valuenow': done }, h('i', { style: `width:${leaves.length ? Math.round((done / leaves.length) * 100) : 0}%` })),
        ),
        h('div', { class: 'rows' }, ...rows),
      ));
    });
  }
  renderDetail();
  const j = $('journal');
  const atBottom = j.scrollTop + j.clientHeight >= j.scrollHeight - 30;
  j.textContent = S.lines.join('\n');
  if ($('autoScroll').checked && (atBottom || !j.dataset.seen)) j.scrollTop = j.scrollHeight;
  j.dataset.seen = '1';
  // прогон закончился — журнал сворачиваем один раз, главное теперь итог
  const key = (S.viewingHistory && S.viewingHistory.id) || (S.result && S.run && S.run.runId) || '';
  if (key && $('journalBox').dataset.folded !== key) { $('journalBox').open = false; $('journalBox').dataset.folded = key; }
  if (!key && S.run && !S.result) { $('journalBox').open = true; $('journalBox').dataset.folded = ''; }
}

/** Что сейчас с задачей — одной короткой фразой. */
function whoText(t) {
  const isActive = S.active && S.active.taskId === t.id;
  const g = S.activity.gpu;
  if (isActive) return g && g.taskId === t.id ? g.text : `${ROLE_RU[S.active.role] || S.active.role}: ${S.active.model}`;
  if (S.activity[`cpu:${t.id}`]) return S.activity[`cpu:${t.id}`].text;
  if (t.status === 'human' && !isBlocked(t)) return 'нужна твоя помощь';
  if (isBlocked(t)) return 'ждёт предыдущую';
  if (t.children && t.children.length && t.status === 'waiting') return 'собирается из частей';
  if (t.status === 'done') return t.doneBy ? `готово, ${t.doneBy}` : 'готово';
  return STATUS_RU[t.status] || t.status;
}

/** Строка задачи и под ней — её части; повторы решения свёрнуты в одну строку. */
function taskRows(t, num, depth, tree) {
  NUM.set(t.id, num);
  const st = effStatus(t);
  const isActive = S.active && S.active.taskId === t.id;
  const kids = tree.childrenOf(t.id);
  const reps = tree.replicasOf(t.id);
  const tags = [];
  if (kids.length) tags.push(h('span', { class: 'tag' }, `частей ${kids.filter((c) => c.status === 'done').length} из ${kids.length}`));
  if (reps.length || t.poolLeader) tags.push(h('span', { class: 'tag pool' }, `образец для ${reps.length || 'других'} файлов`));
  if (t.inputs && t.inputs.length) tags.push(h('span', { class: 'tag' }, 'документы'));
  if (t.humanHint) tags.push(h('span', { class: 'tag hint' }, 'с твоей подсказкой'));
  const row = h('button', {
    class: `trow st-${st}${S.selected === t.id ? ' sel' : ''}${isActive ? ' active' : ''}`,
    style: `--depth:${depth}`,
    'data-depth': String(depth),
    title: t.title,
    onclick: () => { S.selected = S.selected === t.id ? null : t.id; renderBoard(); },
  },
    h('span', { class: 'light', 'aria-hidden': 'true' }),
    h('span', { class: 'num' }, num),
    h('span', { class: 'ttl' }, t.title, ...tags),
    h('span', { class: 'who' }, whoText(t)),
    t.attempts ? h('span', { class: 'tries', title: `попыток агентов: ${t.attempts}` }, `×${t.attempts}`) : h('span', { class: 'tries' }),
  );
  const out = [row];
  // готовую составную задачу не разворачиваем — части видны, если выбрать её
  const open = t.status !== 'done' || S.selected === t.id || kids.some((c) => c.id === S.selected);
  if (kids.length && open) kids.forEach((c, k) => out.push(...taskRows(c, `${num}.${k + 1}`, depth + 1, tree)));
  else kids.forEach((c, k) => NUM.set(c.id, `${num}.${k + 1}`));
  if (reps.length) {
    const done = reps.filter((r) => r.status === 'done').length;
    const bad = reps.filter((r) => effStatus(r) === 'human').length;
    const det = h('details', { class: `replicas${bad ? ' has-bad' : ''}`, style: `--depth:${depth + 1}` },
      h('summary', {}, `Повтор решения ещё в ${reps.length} файлах — готово ${done}${bad ? `, нужна помощь: ${bad}` : ''}`),
      ...reps.flatMap((r, k) => taskRows(r, `${num}.${kids.length + k + 1}`, depth + 1, tree)),
    );
    if (bad || reps.some((r) => r.id === S.selected)) det.open = true;
    out.push(det);
  }
  return out;
}

function renderCounters() {
  const c = $('counters');
  c.replaceChildren();
  const count = {};
  for (const t of S.tasks) count[effStatus(t)] = (count[effStatus(t)] || 0) + 1;
  for (const st of STATUS_ORDER) {
    if (!count[st]) continue;
    c.append(h('span', { class: `cnt st-${st}` }, h('i', {}), `${STATUS_RU[st]}: ${count[st]}`));
  }
  if (!S.tasks.length) c.append(h('span', { class: 'muted small' }, S.run ? '' : 'Прогонов ещё не было — запусти на вкладке «Запуск».'));
}

function renderPlanBox() {
  const box = $('planBox');
  if (!S.plan || S.viewingHistory) { box.hidden = true; return; }
  box.hidden = false;
  const { plan, warnings } = S.plan;
  box.replaceChildren(
    h('h2', {}, `План: ${plan.tasks.length} ${plural(plan.tasks.length, 'задача', 'задачи', 'задач')}`),
    plan.understanding ? h('div', { class: 'understanding' }, h('b', {}, 'Понял так: '), plan.understanding) : '',
    h('p', { class: 'muted small' }, 'Проверь, что задачи про то, что ты просил. После утверждения агенты начнут работу.'),
    ...planStages(plan.tasks).map((g, i) =>
      h('section', { class: 'plan-stage' },
        h('h3', { class: 'plan-stage-name' }, h('span', { class: 'plan-stage-no' }, String(i + 1)), g.name),
        ...g.tasks.map((t, j) =>
          h('div', { class: 'plan-task' },
            h('div', {}, h('span', { class: 'tid' }, `${i + 1}.${j + 1} `), h('b', {}, t.title)),
            h('div', { class: 'small' }, t.brief),
            h('div', { class: 'muted small' }, t.inputs && t.inputs.length ? `Читает: ${t.inputs.join(', ')}; результат: ${t.files.join(', ') || '—'}` : `Файлы: ${t.files.join(', ') || '—'}${t.similar ? `; та же правка во всех по шаблону ${t.similar}` : ''}`),
            t.install && t.install.length ? h('div', { class: 'small install-line' }, `Поставит пакеты npm: ${t.install.join(', ')}`) : '',
          ),
        ),
      ),
    ),
    warnings.length ? h('details', { class: 'files' }, h('summary', {}, `Поправки программы к плану: ${warnings.length}`), h('ul', { class: 'warn-list' }, warnings.map((w) => h('li', {}, w)))) : '',
    h('div', { class: 'row end' },
      h('button', { class: 'btn', onclick: () => decide(false) }, 'Отклонить'),
      h('button', { class: 'btn primary', onclick: () => decide(true) }, 'Утвердить и начать'),
    ),
  );
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

/** План по этапам (как на доске): этап из плана или шаг по зависимостям. */
function planStages(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const lv = (t, seen = new Set()) => (seen.has(t.id) ? 0 : (seen.add(t.id), Math.max(0, ...t.dependsOn.map((d) => byId.get(d)).filter(Boolean).map((d) => lv(d, seen) + 1))));
  const groups = new Map();
  for (const t of tasks) {
    const key = t.stage ? `s:${t.stage}` : `l:${lv(t)}`;
    if (!groups.has(key)) groups.set(key, { name: t.stage || '', tasks: [] });
    groups.get(key).tasks.push(t);
  }
  const list = [...groups.values()];
  list.forEach((g, i) => { if (!g.name) g.name = g.tasks.length === 1 ? g.tasks[0].title : `Шаг ${i + 1}`; });
  return list;
}

async function decide(ok) {
  try { await api('/api/approve', { ok }); } catch (e) { alertBox(e.message); }
}

/** Всё, что нужно для блока итога, — и для живого прогона, и для открытого из истории. */
function outcomeModel() {
  if (S.viewingHistory) {
    const v = S.viewingHistory;
    if (!v.changes) return null;
    const meta = v.changes.meta;
    const applied = v.id in S.appliedNow ? S.appliedNow[v.id] : !!meta.applied;
    return { target: { repo: v.repo, id: v.id }, files: v.changes.files, applied, appliedAt: meta.applied && meta.applied.at, applyMsg: null, human: meta.human, done: meta.done, goal: v.goal_check, understanding: v.understanding, target_branch: meta.target };
  }
  if (!S.result || !S.run) return null;
  const r = S.result;
  return { target: { repo: S.run.repo, id: S.run.runId }, files: r.changes || [], applied: isAppliedLive(), applyMsg: r.applied ? r.applied.message : null, human: r.human, done: r.done, goal: r.goal, understanding: r.understanding, seconds: r.seconds };
}

function needsCount(m) { return m.human.filter((x) => !/^не (начата|собрана)/.test(String(x.why || ''))).length || m.human.length; }

function renderResultBox() {
  const box = $('resultBox');
  if (S.error && !S.viewingHistory) {
    box.hidden = false;
    box.className = 'outcome stopped';
    box.replaceChildren(h('div', { class: 'outcome-head' }, h('div', { class: 'outcome-mark' }, '!'), h('div', { class: 'outcome-text' }, h('div', { class: 'outcome-title' }, 'Прогон остановлен'), h('div', { class: 'outcome-sub' }, 'Проект не изменён.'))), h('div', { class: 'outcome-body' }, h('pre', {}, S.error)));
    return;
  }
  const m = outcomeModel();
  if (!m) { box.hidden = true; return; }
  box.hidden = false;
  const status = h('div', { class: 'status-line', hidden: true });
  const say = (ok, text) => { status.hidden = false; status.className = `status-line ${ok ? 'ok' : 'bad'}`; status.textContent = text; };
  const setApplied = (v) => { S.appliedNow[m.target.id] = v; renderTop(); renderBoard(); };
  const btnApply = h('button', { class: 'btn primary', onclick: async () => {
    try { const res = await api('/api/apply', m.target); if (res.ok) setApplied(true); else say(false, res.message); } catch (e) { say(false, e.message); }
  } }, m.human.length ? 'Применить то, что готово' : 'Применить в проект');
  const btnUndo = h('button', { class: 'btn', onclick: async () => {
    if (!confirmInline(btnUndo, 'Точно откатить?')) return;
    try { const res = await api('/api/unapply', m.target); if (res.ok) setApplied(false); else say(false, res.message); } catch (e) { say(false, e.message); }
  } }, 'Откатить');
  const btnDiff = h('button', { class: 'btn', onclick: () => showDiff(m.target) }, 'Показать изменения');

  let cls, mark, title, sub, actions;
  const n = m.files.length;
  if (m.applied) {
    cls = 'in'; mark = '✓'; title = 'Результат в проекте';
    sub = `Изменено файлов: ${n}. Открой проект (или пересобери Docker) — изменения уже там. Не понравилось — «Откатить».`;
    actions = [btnDiff, btnUndo];
  } else if (!n) {
    cls = 'out'; mark = '–'; title = 'Проект не изменён';
    sub = m.human.length ? 'Агенты ничего не довели до конца — ниже задачи, которые ждут тебя.' : 'Прогон закончился без изменений в файлах.';
    actions = [];
  } else {
    cls = 'out'; mark = '!'; title = 'Результат ещё не в проекте';
    sub = m.human.length
      ? `Готовые правки (${n} ${plural(n, 'файл', 'файла', 'файлов')}) лежат в отдельной ветке и в проект не попали: ${needsCount(m)} ${plural(needsCount(m), 'задача ждёт', 'задачи ждут', 'задач ждут')} тебя. Подскажи агентам, на чём они споткнулись, — дальше они сами, и результат применится. Или примени то, что уже есть.`
      : `${m.applyMsg || 'Автоприменение было выключено.'} Изменения (${n} ${plural(n, 'файл', 'файла', 'файлов')}) лежат в отдельной ветке.`;
    actions = [btnApply, btnDiff];
  }
  const ru = { added: 'новый', modified: 'изменён', deleted: 'удалён', renamed: 'переименован' };
  const needs = m.human.filter((x) => !/^не (начата|собрана)/.test(String(x.why || '')));
  const waiting = m.human.length - needs.length;
  box.className = `outcome ${cls}`;
  box.replaceChildren(
    h('div', { class: 'outcome-head' },
      h('div', { class: 'outcome-mark' }, mark),
      h('div', { class: 'outcome-text' }, h('div', { class: 'outcome-title' }, title), h('div', { class: 'outcome-sub' }, sub)),
      h('div', { class: 'outcome-actions' }, actions),
    ),
    h('div', { class: 'outcome-body' },
      m.goal ? h('div', { class: `verdict ${m.goal.achieved ? 'ok' : 'bad'}` },
        h('b', {}, m.goal.achieved === true ? 'Приёмка: цель достигнута.' : m.goal.achieved === false ? 'Приёмка: цель достигнута не полностью.' : 'Приёмка не дала ответа — оцени результат сам.'),
        m.goal.achieved === false && m.goal.missing && m.goal.missing.length ? ` Не хватает: ${m.goal.missing.join('; ')}.` : '') : '',
      m.understanding ? h('div', { class: 'understanding' }, h('b', {}, 'Понял цель так: '), m.understanding) : '',
      reworkBlock(m),
      needs.length ? h('div', { class: 'needs-you' },
        h('div', { class: 'small' }, h('b', {}, `Ждут тебя: ${needs.length}`), waiting ? h('span', { class: 'muted' }, `. Ещё ${waiting} начнутся сами, когда эти будут сделаны.`) : ''),
        needs.map((x) => h('div', { class: 'need' },
          h('span', { class: 'need-num' }, NUM.get(x.id) || x.id),
          h('span', { class: 'why', title: whyText(x.why) }, h('b', {}, taskTitle(x.id)), ' — ', whyText(x.why)),
          h('button', { class: 'btn sm', title: 'Планировщик разобьёт задачу на подзадачи поменьше (можно другим путём), агенты попробуют снова', onclick: async (ev) => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            try { await api('/api/human/retry', { ...m.target, taskId: x.id, mock: MOCK, autoApply: $('optAutoApply').checked }); } catch (e) { alertBox(e.message); btn.disabled = false; }
          } }, /поставить пакеты/.test(x.why) ? 'Повторить без меня' : 'Разбить и повторить'),
          h('button', { class: 'btn sm flag', onclick: () => { S.selected = x.id; renderBoard(); $('detail').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } }, 'Посмотреть, в чём дело'),
        ))) : '',
      n ? publishBlock(m.target) : '',
      n ? h('details', { class: 'files' }, h('summary', {}, `Изменённые файлы: ${n}`),
        h('table', { class: 'tbl' }, h('tbody', {}, m.files.map((f) => h('tr', {}, h('td', { class: 'mono' }, f.file), h('td', { class: 'small nowrap' }, ru[f.status] || f.status), h('td', { class: 'small mono nowrap' }, `+${f.added} −${f.removed}`)))))) : '',
      status,
    ),
  );
}

/** «Отправить на доработку»: прогон продолжается в той же ветке — недостающее по приёмке и то, что напишет человек. */
function reworkBlock(m) {
  const partial = m.goal && m.goal.achieved === false;
  const note = h('textarea', { class: 'rework-note', rows: 2, placeholder: partial
    ? 'Что ещё сделать? Можно оставить пустым — агенты возьмут то, чего не хватает по приёмке.'
    : 'Что доделать или поправить? Например: «шапку сделай на Mantine, с логотипом и поиском»' });
  const status = h('div', { class: 'status-line', hidden: true });
  const btn = h('button', { class: `btn ${partial ? 'primary' : ''}`, onclick: async () => {
    if (!partial && !note.value.trim()) { status.hidden = false; status.className = 'status-line bad'; status.textContent = 'Напиши, что доделать: приёмка считает, что цель достигнута.'; return; }
    btn.disabled = true;
    status.hidden = false; status.className = 'status-line'; status.textContent = 'Отправляю на доработку…';
    try {
      await api('/api/rework', { ...m.target, note: note.value.trim(), mock: MOCK, autoApply: $('optAutoApply').checked });
      status.className = 'status-line ok';
      status.textContent = 'Отправлено: планировщик составит задачи доработки, агенты продолжат этот же прогон — смотри доску. Результат применится поверх.';
      if (S.viewingHistory) { S.viewingHistory = null; renderTop(); }
    } catch (e) { btn.disabled = false; status.className = 'status-line bad'; status.textContent = e.message; }
  } }, 'Отправить на доработку');
  return h('div', { class: 'rework' },
    h('div', { class: 'small' }, h('b', {}, 'Доработать'), h('span', { class: 'muted' }, partial ? ' — агенты продолжат с того, чего не хватает' : ' — если что-то не так, напиши что')),
    note,
    h('div', { class: 'row' }, btn),
    status,
  );
}

async function showDiff(target) {
  try {
    const res = await fetch(`/api/diff?repo=${encodeURIComponent(target.repo)}&id=${encodeURIComponent(target.id)}&t=${encodeURIComponent(TOKEN)}`);
    modal('Изменения прогона', h('pre', { class: 'diff' }, ...colorDiff(await res.text())));
  } catch (e) { alertBox(e.message); }
}

function colorDiff(text) {
  return text.split('\n').map((l) => h('span', { class: l.startsWith('+') && !l.startsWith('+++') ? 'd-add' : l.startsWith('-') && !l.startsWith('---') ? 'd-del' : l.startsWith('@@') ? 'd-hunk' : l.startsWith('diff ') ? 'd-file' : '' }, `${l}\n`));
}

function renderDetail() {
  const box = $('detail');
  const t = S.tasks.find((x) => x.id === S.selected);
  if (!t) {
    box.replaceChildren(h('div', { class: 'placeholder' }, S.tasks.some((x) => x.status === 'human')
      ? 'Задачи с красной меткой ждут тебя. Нажми на такую — покажу, на чём споткнулись агенты, и можно будет подсказать решение.'
      : 'Нажми на задачу — здесь будет, что она делает, как идёт и что пробовали агенты.'));
    return;
  }
  const target = boardTarget();
  const sec = (title, body) => h('div', { class: 'sec' }, h('b', {}, title), body);
  const blocked = isBlocked(t);
  const link = (id) => h('button', { class: 'tlink', onclick: () => { S.selected = id; renderBoard(); } }, id);
  box.replaceChildren(
    h('div', { class: 'detail-head' },
      h('span', { class: 'detail-num' }, NUM.get(t.id) || ''),
      h('span', { class: `badge st-${effStatus(t)}` }, isBlocked(t) ? 'ждёт очереди' : STATUS_RU[t.status]),
    ),
    h('h3', { class: 'detail-title' }, t.title),
    h('div', { class: 'sub' }, t.stage ? h('span', {}, `Этап: ${t.stage}`) : '', h('span', {}, ROLE_RU[t.role] || t.role), t.status === 'done' && t.doneBy ? h('span', {}, `сделал ${t.doneBy}`) : '', h('span', { class: 'mono muted', title: 'внутренний номер задачи' }, t.id)),
    t.stumble && t.status !== 'done' && !blocked && target ? stumbleBlock(t, target) : '',
    t.status === 'human' && !blocked && target ? handoffBlock(t, target) : '',
    blocked ? h('div', { class: 'sec small muted' }, `Начнётся сама: ${t.humanWhy.replace(/^не (начата|собрана): /, '')}. Доделай ту задачу — эта пойдёт следом.`) : '',
    t.status === 'human' && !blocked ? '' : sec('Что сделать', h('div', { class: 'small', style: 'white-space:pre-wrap' }, t.brief)),
    t.steps && t.steps.length ? sec('Шаги', h('ol', { class: 'small steps' }, t.steps.map((x) => h('li', {}, x)))) : '',
    t.doneWhen && t.doneWhen.length ? sec('Готово, когда (проверит программа)', h('ul', { class: 'small' }, t.doneWhen.map((d) => h('li', {}, h('span', { class: 'mono' }, d.file), ': ', [d.lacks && d.lacks.length ? `нет ${d.lacks.join(', ')}` : '', d.has && d.has.length ? `есть ${d.has.join(', ')}` : ''].filter(Boolean).join('; '))))) : '',
    t.children && t.children.length ? sec('Собирается из частей', h('div', { class: 'small' }, ...t.children.flatMap((c, i) => [i ? ', ' : '', link(c), ` (${STATUS_RU[(S.tasks.find((x) => x.id === c) || {}).status] || '—'})`]))) : '',
    t.parent ? sec('Часть задачи', h('div', { class: 'small' }, link(t.parent), ' — решения соседних частей передаются этой, а её решения — наверх.')) : '',
    t.pool ? sec('Пул однотипных задач', h('div', { class: 'small' }, t.poolLeader ? 'Это образец: его решение программа повторит в остальных задачах пула.' : ['Решение ', t.solutionFrom ? link(t.solutionFrom) : link(t.pool), t.solutionFrom ? ' уже принято — здесь его повтор.' : ' сначала делается на образце, потом повторяется здесь.'])) : '',
    t.dependsOn.length ? sec('Начнётся после', h('ul', { class: 'small' }, t.dependsOn.map((d) => h('li', {}, h('button', { class: 'tlink plain', onclick: () => { S.selected = d; renderBoard(); } }, `${taskNo(d)} ${taskTitle(d)}`))))) : '',
    sec('Файлы', h('ul', { class: 'small mono' }, t.files.map((f) => h('li', {}, f, t.frozen.includes(f) ? ' (заморожен)' : '')))),
    t.tests.length || t.commands.length ? sec('Когда готово', h('ul', { class: 'small' }, [...t.tests.map((x) => `тест ${x} ${t.type === 'test' ? 'должен упасть' : 'должен пройти'}`), ...t.commands.map((x) => `команда ${x}`)].map((x) => h('li', {}, x)))) : '',
    t.attempts ? sec('Попытки агентов', h('div', { class: 'small' }, `${t.attempts}${t.ladderStep ? `, дошли до ступени «${LADDER_RU[t.ladderStep]}»` : ''}`)) : '',
    t.inputs && t.inputs.length ? sec('Исходные материалы', h('ul', { class: 'small mono' }, t.inputs.map((f) => h('li', {}, f.split(/[\\/]/).slice(-2).join('/'))))) : '',
    t.lastError && !t.stumble ? sec('Последняя ошибка', h('pre', {}, t.lastError)) : '',
    t.lastError && t.stumble ? h('details', { class: 'sec files' }, h('summary', {}, 'Полный текст последней ошибки'), h('pre', {}, t.lastError)) : '',
    t.reference ? sec('Справка, которую нашла программа (уйдёт исполнителю)', refBlock(t.reference)) : '',
    target ? sec('Переписка агентов', transcriptLinks(target.repo, target.id, t.id)) : '',
  );
}

/** На чём споткнулись: ступень, ошибки с местом, что пробовали — и поле для решения человека. */
function stumbleBlock(t, target) {
  const st = t.stumble;
  const note = S.humanNote[`hint:${t.id}`];
  const status = h('div', { class: `status-line ${note && !note.ok ? 'bad' : note ? 'ok' : ''}` }, note ? note.text : '');
  const say = (text, ok = true) => { S.humanNote[`hint:${t.id}`] = { text, ok }; status.className = `status-line ${ok ? 'ok' : 'bad'}`; status.textContent = text; };
  const draftKey = `hintDraft:${target.id}:${t.id}`;
  const area = h('textarea', { class: 'inp hint-input', rows: 5, placeholder: 'Вставь решение: кусок кода, правильный импорт, имя свойства — или коротко, что сделать иначе.', spellcheck: 'false' });
  area.value = recall(draftKey) || '';
  area.addEventListener('input', () => remember(draftKey, area.value));
  const send = h('button', { class: 'btn primary', onclick: async () => {
    const hint = area.value.trim();
    if (!hint) { say('Напиши подсказку — хоть пару слов.', false); return; }
    send.disabled = true;
    try {
      say('Передаю подсказку агентам…');
      const r = await api('/api/human/hint', { ...target, taskId: t.id, hint, mock: MOCK, autoApply: $('optAutoApply').checked });
      remember(draftKey, '');
      area.value = '';
      say(r.mode === 'resume' ? 'Подсказка передана: прогон продолжен, задача снова у агентов.' : 'Подсказка передана: исполнитель возьмёт задачу с ней следующим шагом.');
    } catch (e) { say(e.message, false); } finally { send.disabled = false; }
  } }, t.status === 'human' ? 'Передать агентам с подсказкой' : 'Добавить подсказку к следующей попытке');
  return h('div', { class: 'stumble' },
    h('h4', {}, 'На чём споткнулись'),
    h('div', { class: 'stumble-stage' }, st.stage),
    st.errors.length ? '' : h('p', { class: 'stumble-summary' }, st.summary.replace(/^[^:]+:\s*/, '')),
    st.errors.length ? h('ul', { class: 'stumble-errors' }, st.errors.map((e) => h('li', {}, e.where ? h('span', { class: 'where' }, e.where) : '', h('span', { class: 'what' }, e.text)))) : '',
    st.tried.length ? h('details', { class: 'files' }, h('summary', {}, `Что пробовали: ${st.tried.length} попыт${st.tried.length === 1 ? 'ка' : st.tried.length < 5 ? 'ки' : 'ок'}`), h('ol', { class: 'small tried' }, st.tried.map((x) => h('li', {}, x.replace(/^\d+\.\s*/, ''))))) : '',
    t.humanHint ? h('details', { class: 'files' }, h('summary', {}, 'Твоя подсказка (уже у агентов)'), h('pre', {}, t.humanHint)) : '',
    h('p', { class: 'stumble-need' }, st.need),
    area,
    h('div', { class: 'row' }, send),
    status,
  );
}

/** Задача у человека: что сделать, открыть файлы, сдать. */
function handoffBlock(t, target) {
  const hs = S.handoff[t.id];
  const note = S.humanNote[t.id];
  const status = h('div', { class: `status-line ${note && !note.ok ? 'bad' : ''}` }, note ? note.text : '');
  const watch = h('input', { type: 'checkbox', checked: recall('autoCheck') !== '0' });
  watch.addEventListener('change', () => remember('autoCheck', watch.checked ? '1' : '0'));
  const say = (text, ok = true) => { S.humanNote[t.id] = { text, ok }; status.className = `status-line ${ok ? '' : 'bad'}`; status.textContent = text; };
  const body = { ...target, taskId: t.id, mock: MOCK, autoApply: $('optAutoApply').checked };
  const open = h('button', { class: 'btn flag', onclick: async () => {
    try {
      const r = await api('/api/human/open', { ...body, watch: watch.checked });
      S.handoff[t.id] = { dir: r.dir, files: r.files, watching: watch.checked };
      S.humanNote[t.id] = { ok: true, text: r.editor && r.editor !== 'none' ? `Открыто в ${r.editor}. ${watch.checked ? 'Сохрани файл — проверю и продолжу сам.' : 'Поправь, сохрани и нажми «Готово».'}` : 'Рабочая копия готова — открой файлы ниже в своём редакторе.' };
      renderDetail();
    } catch (e) { say(e.message, false); }
  } }, hs ? 'Открыть ещё раз' : 'Открыть в редакторе');
  if (hs) open.className = 'btn';
  const done = h('button', { class: 'btn primary', onclick: async () => {
    try { say('Проверяю правку…'); const r = await api('/api/human/done', body); if (r.mode === 'live') say('Принято — проверю, как только освободится конвейер.'); } catch (e) { say(e.message, false); }
  } }, 'Готово — проверить и продолжить');
  const retry = h('button', { class: 'btn', onclick: async () => {
    try {
      retry.disabled = true;
      say('Передаю агентам: разобьют на подзадачи и попробуют без тебя…');
      const r = await api('/api/human/retry', body);
      if (r.mode === 'resume') say('Запустил продолжение прогона — задача снова у агентов.');
    } catch (e) { retry.disabled = false; say(e.message, false); }
  } }, /поставить пакеты/.test(t.humanWhy || '') ? 'Попробовать ещё раз без меня' : 'Разбить на подзадачи и попробовать без меня');
  // проверочная задача или правка не нужна — закрыть без правки, цепочка идёт дальше
  const close = h('button', { class: 'btn', title: 'Задача не нужна или всё уже так: закрыть её без правки, агенты пойдут дальше', onclick: async () => {
    try { say('Закрываю задачу…'); await api('/api/human/done', { ...body, close: true }); } catch (e) { say(e.message, false); }
  } }, 'Менять нечего — закрыть');
  const reset = h('button', { class: 'btn ghost', onclick: async () => {
    if (!confirmInline(reset, 'Стереть мою правку?')) return;
    try { await api('/api/human/drop', body); delete S.handoff[t.id]; say('Ручная копия убрана. Можно открыть заново.'); renderDetail(); } catch (e) { say(e.message, false); }
  } }, 'Начать заново');
  // была ли копия открыта раньше (окно перезапускали)
  if (!hs) {
    api(`/api/human/status?repo=${encodeURIComponent(target.repo)}&id=${encodeURIComponent(target.id)}&taskId=${encodeURIComponent(t.id)}`)
      .then((st) => { if (st.exists && !S.handoff[t.id]) { S.handoff[t.id] = { dir: st.dir, files: st.files || [], watching: st.watching, changed: st.changed }; renderDetail(); } })
      .catch(() => undefined);
  }
  const files = t.files.filter((f) => !f.includes('*'));
  return h('div', { class: 'handoff' },
    h('h4', {}, 'Другие варианты'),
    t.stumble ? '' : h('div', { class: 'why' }, h('b', {}, 'Почему остановились: '), whyText(t.humanWhy)),
    h('div', { class: 'row' }, retry, close),
    h('div', { class: 'small muted' }, 'Или поправь сам — откроется отдельная копия, твои файлы не тронуты:'),
    h('div', { class: 'todo' }, t.brief || t.title),
    h('div', { class: 'small' }, `Файл${files.length > 1 ? 'ы' : ''}: `, h('span', { class: 'mono' }, files.join(', ') || '—')),
    hs ? h('div', {}, h('div', { class: 'small muted' }, 'Правь здесь (это отдельная копия прогона, твоя ветка не тронута):'), h('div', { class: 'paths' }, ...(hs.files.length ? hs.files : [hs.dir]).flatMap((f) => [f, h('br')]))) : '',
    h('label', { class: 'chk small' }, watch, 'Проверять сразу после сохранения файла'),
    h('div', { class: 'row' }, hs ? done : open, hs ? open : '', hs ? reset : ''),
    status,
    h('div', { class: 'small muted' }, 'После проверки правка вливается в прогон, задачи после неё агенты сделают сами, а результат применится в проект.'),
  );
}

function transcriptLinks(repo, id, taskId) {
  const wrap = h('div', {}, h('span', { class: 'muted small' }, 'загружаю…'));
  runInfo(repo, id)
    .then((r) => {
      const mine = r.transcripts.filter((n) => n.replace(/^\d+-/, '').startsWith(`${taskId}-`) && /-(ok|fail)\.json$/.test(n) && n.replace(/^\d+-/, '').slice(taskId.length + 1).split('-').length === 2);
      wrap.replaceChildren(...(mine.length ? mine.map((n) => h('div', {}, h('button', { class: 'tlink', onclick: () => openTranscript(repo, id, n) }, n))) : [h('span', { class: 'muted small' }, 'пока нет')]));
    })
    .catch(() => wrap.replaceChildren(h('span', { class: 'muted small' }, 'нет данных')));
  return wrap;
}

// список переписок обновляем не чаще раза в 2 секунды — доска перерисовывается на каждое событие
const runInfoCache = new Map();
function runInfo(repo, id) {
  const key = `${repo}|${id}`;
  const hit = runInfoCache.get(key);
  if (hit && Date.now() - hit.at < 2000) return hit.p;
  const p = api(`/api/run?repo=${encodeURIComponent(repo)}&id=${encodeURIComponent(id)}`);
  runInfoCache.set(key, { at: Date.now(), p });
  return p;
}

async function openTranscript(repo, id, name) {
  try {
    const t = await api(`/api/transcript?repo=${encodeURIComponent(repo)}&id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`);
    const msgs = (t.messages || []).map((m) => h('div', { class: 'msg' }, h('div', { class: 'who' }, m.role === 'system' ? 'Инструкция (система)' : m.role === 'user' ? 'Запрос программы' : m.role === 'assistant' ? `Ответ модели ${t.model}` : m.role), h('pre', {}, m.content || (m.tool_calls ? JSON.stringify(m.tool_calls, null, 2) : ''))));
    modal(`${t.task}, ${ROLE_RU[t.role] || t.role}, ${t.model}: ${t.ok ? 'сдал' : 'не справился'}`, [t.error ? h('pre', {}, t.error) : '', ...msgs]);
  } catch (e) { alertBox(e.message); }
}

function reportTarget() {
  if (S.viewingHistory && S.viewingHistory.hasReport) return S.viewingHistory;
  if (S.result && S.run) return { repo: S.run.repo, id: S.run.runId };
  return null;
}
function reportUrl(r) { return `/api/report?repo=${encodeURIComponent(r.repo)}&id=${encodeURIComponent(r.id)}&t=${encodeURIComponent(TOKEN)}`; }
$('reportBtn').addEventListener('click', () => { const r = reportTarget(); if (r) window.open(reportUrl(r), '_blank'); });
$('pdfBtn').addEventListener('click', async () => {
  const r = reportTarget();
  if (!r) return;
  const url = new URL(reportUrl(r), location.href).href;
  if (desktop && desktop.savePdf) {
    const saved = await desktop.savePdf(url, `agentyard-${r.id}.pdf`);
    if (saved) alertBox(`PDF сохранён: ${saved}`);
  } else {
    const w = window.open(url, '_blank');
    if (w) w.addEventListener('load', () => w.print());
  }
});

// ---------- модели ----------

const pullState = {};
const pullErrors = {};
let modelsData = null;

async function loadModels() {
  try {
    modelsData = await api('/api/models');
    if (modelsData.team.length && !S.team.length) S.team = modelsData.team;
    renderModels();
    renderTop();
  } catch (e) { $('hwCard').replaceChildren(h('div', { class: 'err' }, e.message)); }
}
$('refreshModels').addEventListener('click', loadModels);

function renderModels() {
  if (!modelsData) return;
  const { hw, tierText, online, rows, team, otherInstalled } = modelsData;
  $('hwCard').replaceChildren(
    h('h2', {}, 'Железо'),
    h('div', { class: 'hw' },
      h('div', {}, h('b', {}, 'Видеокарта'), h('span', {}, hw.gpuName || 'не найдена')),
      h('div', {}, h('b', {}, 'Видеопамять'), h('span', {}, `${hw.vramTotalGb} ГБ`), h('div', { class: 'muted small' }, `свободно ${hw.vramFreeGb} ГБ`)),
      h('div', {}, h('b', {}, 'Оперативка'), h('span', {}, `${hw.ramTotalGb} ГБ`), h('div', { class: 'muted small' }, `свободно ${hw.ramFreeGb} ГБ`)),
      h('div', {}, h('b', {}, 'Тир'), h('span', {}, hw.tier)),
      h('div', {}, h('b', {}, 'Ollama'), h('span', { style: `color:var(${online ? '--s-done' : '--s-human'})` }, online ? 'работает' : 'не отвечает')),
    ),
    h('p', { class: 'small' }, tierText),
    team.length ? h('p', { class: 'small' }, h('b', {}, 'Бригада из скачанных моделей: '), team.join(' + ')) : h('p', { class: 'small muted' }, online ? 'Скачанных моделей из каталога нет — скачай подходящие ниже.' : 'Запусти Ollama, чтобы увидеть скачанные модели.'),
    otherInstalled.length ? h('p', { class: 'small muted' }, `Есть и модели вне каталога: ${otherInstalled.join(', ')} — конвейер может их использовать с осторожной оценкой.`) : '',
  );
  const fitRu = { yes: 'влезет', 'moe-offload': 'часть в RAM', offload: 'с выгрузкой', no: 'не влезет' };
  const bar = (v) => h('span', {}, h('span', { class: 'bar' }, h('i', { style: `width:${Math.round((v || 0) * 100)}%` })), (v || 0).toFixed(2));
  const tbl = $('modelsTbl');
  tbl.replaceChildren(
    h('thead', {}, h('tr', {}, ['Модель', 'Параметры', 'ГБ с контекстом', 'Память', 'Кодер', 'Ревьюер', 'Планировщик', 'Лицензия', ''].map((x) => h('th', {}, x)))),
    h('tbody', {}, rows
      .slice()
      .sort((a, b) => (b.installed - a.installed) || (['yes', 'moe-offload', 'offload', 'no'].indexOf(a.fit) - ['yes', 'moe-offload', 'offload', 'no'].indexOf(b.fit)) || ((b.roles.coder || 0) - (a.roles.coder || 0)))
      .map((m) => {
        const pulling = pullState[m.tag] || m.pulling;
        const action = m.installed
          ? h('span', { class: 'muted small' }, 'скачана')
          : pulling
            ? h('span', { class: 'small' }, pulling)
            : m.fit === 'no' || !online
              ? ''
              : h('button', { class: 'btn', onclick: async (ev) => { ev.target.disabled = true; pullState[m.tag] = 'старт'; try { await api('/api/models/pull', { tag: m.tag }); } catch (e) { alertBox(e.message); } renderModels(); } }, 'Скачать');
        return h('tr', { class: m.fit === 'no' || m.legacy ? 'dim' : '' },
          h('td', { class: 'mono' }, m.tag, m.legacy ? ' (старая)' : ''),
          h('td', {}, m.active && m.active !== m.params ? `${m.params}B, активных ${m.active}B` : `${m.params}B`),
          h('td', {}, m.gb),
          h('td', {}, h('span', { class: `fit ${m.fit}` }, fitRu[m.fit])),
          h('td', {}, bar(m.roles.coder)),
          h('td', {}, bar(m.roles.reviewer)),
          h('td', {}, bar(m.roles.planner)),
          h('td', { class: 'small' }, m.license),
          h('td', {}, action, pullErrors[m.tag] ? h('div', { class: 'hint bad' }, pullErrors[m.tag]) : ''),
        );
      })),
  );
}

// ---------- история ----------

async function loadRuns() {
  const repo = repoInp.value.trim() || (S.run && S.run.repo) || '';
  $('histRepo').textContent = repo ? `Проект: ${repo}` : 'Укажи папку проекта на вкладке «Запуск».';
  const tbl = $('runsTbl');
  if (!repo) { tbl.replaceChildren(); return; }
  const say = (ok, text) => { const st = $('histStatus'); st.hidden = false; st.className = `status-line ${ok ? 'ok' : 'bad'}`; st.textContent = text; };
  try {
    const runs = await api(`/api/runs?repo=${encodeURIComponent(repo)}`);
    const act = (label, cls, fn) => h('button', { class: `btn sm ${cls}`, onclick: async (ev) => { ev.stopPropagation(); await fn(ev.currentTarget); } }, label);
    tbl.replaceChildren(
      h('thead', {}, h('tr', {}, ['Когда', 'Что просили', 'Итог', 'В проекте', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, runs.length ? runs.map((r) => {
        const result = r.done == null
          ? (r.resumable ? h('span', { class: 'pill wait' }, 'прервался') : h('span', { class: 'pill out' }, 'не дошёл'))
          : h('span', {}, `готово ${r.done}`, r.human ? h('span', { class: 'pill wait', style: 'margin-left:6px' }, `не сделано ${r.human}`) : '');
        const inProject = r.applied
          ? h('span', { class: 'pill in', title: `применено ${new Date(r.applied).toLocaleString('ru-RU')}` }, '✓ применён')
          : h('span', { class: 'pill out' }, r.finished ? 'не применён' : '—');
        const acts = [];
        if (r.applied) {
          acts.push(act('Откатить', '', async (btn) => {
            if (!confirmInline(btn, 'Точно откатить?')) return;
            try { const res = await api('/api/unapply', { repo, id: r.id }); say(res.ok, res.message); loadRuns(); } catch (e) { say(false, e.message); }
          }));
        } else if (r.finished) {
          acts.push(act('Применить', '', async () => {
            try { const res = await api('/api/apply', { repo, id: r.id }); say(res.ok, res.message); loadRuns(); } catch (e) { say(false, e.message); }
          }));
        }
        if (r.resumable) acts.push(act('Продолжить', 'primary', () => resumeRun(repo, r.id)));
        acts.push(act('Открыть', 'ghost', () => openRun(repo, r)));
        return h('tr', { class: 'click', onclick: () => openRun(repo, r) },
          h('td', { class: 'nowrap' }, fmtRunId(r.id)),
          h('td', { style: 'min-width:220px' }, r.goal === 'fix-tests' ? 'починить падающие тесты' : r.goal,
            r.issue || r.pr ? h('div', { class: 'small' }, r.issue ? h('a', { href: r.issue.url, target: '_blank', rel: 'noopener', onclick: (ev) => ev.stopPropagation() }, r.issue.key) : '', r.issue && r.pr ? ', ' : '', r.pr ? h('a', { href: r.pr, target: '_blank', rel: 'noopener', onclick: (ev) => ev.stopPropagation() }, 'PR/MR') : '') : ''),
          h('td', { class: 'nowrap' }, result, r.seconds ? h('div', { class: 'muted small' }, fmtSec(r.seconds)) : ''),
          h('td', { class: 'nowrap' }, inProject),
          h('td', {}, h('div', { class: 'acts' }, acts)),
        );
      }) : h('tr', {}, h('td', { colspan: 5, class: 'muted' }, 'Прогонов ещё не было.'))),
    );
  } catch (e) { tbl.replaceChildren(h('tr', {}, h('td', { class: 'err' }, e.message))); }
}
$('refreshRuns').addEventListener('click', loadRuns);

async function resumeRun(repo, id) {
  try {
    await api('/api/resume', { repo, id, autoApply: $('optAutoApply').checked, allowInstall: $('optInstall').checked, mock: MOCK });
    show('board');
  } catch (e) { alertBox(e.message); }
}

async function openRun(repo, r) {
  try {
    const d = await api(`/api/run?repo=${encodeURIComponent(repo)}&id=${encodeURIComponent(r.id)}`);
    const ch = await api(`/api/changes?repo=${encodeURIComponent(repo)}&id=${encodeURIComponent(r.id)}`).catch(() => null);
    const evs = d.events.map((x) => x.event);
    const gc = evs.filter((e) => e.type === 'goal-check').at(-1);
    const plan = evs.find((e) => e.type === 'plan');
    S.viewingHistory = { repo, id: r.id, goal: r.goal, hasReport: d.hasReport, changes: ch, goal_check: gc ? { achieved: gc.achieved, missing: gc.missing } : null, understanding: plan && plan.understanding };
    S.tasks = d.tasks || tasksFromEvents(d.events);
    S.active = null;
    S.lines = d.lines;
    S.selected = null;
    S.plan = null;
    show('board');
    renderTop();
  } catch (e) { alertBox(e.message); }
}

/** Старые прогоны без tasks.json: собираем карточки из событий журнала. */
function tasksFromEvents(events) {
  const plan = events.find((x) => x.event.type === 'plan');
  if (!plan) return [];
  const tasks = new Map(plan.event.tasks.map((t) => [t.id, { id: t.id, type: t.type, role: t.type === 'test' ? 'tester' : 'coder', title: t.title, brief: '', status: 'waiting', dependsOn: t.dependsOn, files: [], tests: [], commands: [], frozen: [], attempts: 0, ladderStep: 0 }]));
  for (const { event: e } of events) {
    const t = tasks.get(e.taskId);
    if (!t) continue;
    if (e.type === 'merged') t.status = 'done';
    if (e.type === 'human') { t.status = 'human'; t.humanWhy = e.why; }
    if (e.type === 'agent-done' && e.role !== 'reviewer') { t.attempts += 1; t.lastModel = e.model; }
    if (e.type === 'escalate') t.ladderStep = e.step;
  }
  return [...tasks.values()];
}

// ---------- задачи с досок и git ----------

const PROVIDER_FIELDS = {
  github: { name: 'GitHub', fields: [['token', 'Токен', 'Settings → Developer settings → Fine-grained token: доступ к репозиторию, права Issues и Pull requests (чтение и запись)'], ['repo', 'Репозиторий owner/repo', 'необязательно — возьму из remote origin проекта'], ['api', 'Адрес API', 'только для GitHub Enterprise']] },
  gitlab: { name: 'GitLab', fields: [['url', 'Адрес GitLab', 'https://gitlab.com или свой сервер'], ['token', 'Токен', 'Preferences → Access tokens: scope api'], ['project', 'Проект группа/имя', 'необязательно — возьму из remote origin']] },
  jira: { name: 'Jira', fields: [['url', 'Адрес Jira', 'https://company.atlassian.net или свой сервер'], ['email', 'Email', 'только для Jira Cloud (вместе с API-токеном)'], ['token', 'Токен', 'Cloud: API token в id.atlassian.com; Server: персональный токен'], ['jql', 'Какие задачи (JQL)', 'по умолчанию — мои незакрытые']] },
  trello: { name: 'Trello', fields: [['key', 'API key', 'trello.com/power-ups/admin → API key'], ['token', 'Токен', 'выдаётся там же по ссылке Token'], ['boardId', 'ID доски', 'из адреса доски trello.com/b/<ID>/…'], ['list', 'Колонка', 'необязательно — например «To Do»']] },
  youtrack: { name: 'YouTrack', fields: [['url', 'Адрес YouTrack', 'https://company.youtrack.cloud'], ['token', 'Токен', 'Профиль → Account security → New token'], ['query', 'Какие задачи', 'по умолчанию — for: me #Unresolved']] },
};
let intConfig = {};
let pendingIssue = null;

async function loadIntegrations() {
  try {
    const r = await api('/api/integrations');
    intConfig = r.config;
    $('intFile').textContent = `Токены хранятся только на этом компьютере: ${r.file}. Агентам они не видны.`;
    renderProviders();
    loadIssues();
  } catch (e) { $('providersBox').replaceChildren(h('div', { class: 'err' }, e.message)); }
}

function renderProviders() {
  const box = $('providersBox');
  box.replaceChildren(...Object.entries(PROVIDER_FIELDS).map(([id, p]) => {
    const cur = intConfig[id] || null;
    const inputs = {};
    const status = h('div', { class: 'status-line', hidden: true });
    const body = h('div', { class: 'prov-fields' }, p.fields.map(([key, label, hint]) => {
      const secret = /token|key/i.test(key);
      const inp = h('input', { class: 'inp', type: secret ? 'password' : 'text', spellcheck: 'false', placeholder: secret && cur && cur[key] ? 'задан — оставь пустым, чтобы не менять' : '', value: !secret && cur && cur[key] ? cur[key] : '' });
      inputs[key] = inp;
      return h('label', { class: 'prov-field' }, h('span', { class: 'small' }, label), inp, h('span', { class: 'muted small' }, hint));
    }));
    const save = h('button', { class: 'btn primary sm', onclick: async () => {
      try {
        const settings = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
        const r = await api('/api/integrations', { provider: id, settings });
        intConfig = r.config;
        status.hidden = false; status.className = 'status-line ok'; status.textContent = 'Сохранено. Проверяю задачи…';
        await loadIssues();
        status.textContent = 'Сохранено.';
      } catch (e) { status.hidden = false; status.className = 'status-line bad'; status.textContent = e.message; }
    } }, 'Сохранить');
    const off = h('button', { class: 'btn ghost sm', onclick: async () => {
      try { const r = await api('/api/integrations', { provider: id, settings: null }); intConfig = r.config; renderProviders(); loadIssues(); } catch (e) { alertBox(e.message); }
    } }, 'Отключить');
    return h('details', { class: 'prov', open: !!cur },
      h('summary', {}, h('b', {}, p.name), cur ? h('span', { class: 'pill in' }, 'подключено') : h('span', { class: 'pill out' }, 'не подключено')),
      body, h('div', { class: 'row' }, save, cur ? off : ''), status);
  }));
}

async function loadIssues() {
  const box = $('issuesBox');
  if (!Object.keys(intConfig).length) { box.replaceChildren(h('p', { class: 'muted small' }, 'Подключи доску ниже — здесь появятся задачи.')); return; }
  box.replaceChildren(h('p', { class: 'muted small' }, 'Загружаю задачи…'));
  try {
    const repo = repoInp.value.trim();
    const r = await api(`/api/issues${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`);
    box.replaceChildren(
      ...r.errors.map((e) => h('div', { class: 'hint bad' }, e.error.startsWith(PROVIDER_FIELDS[e.provider].name) ? e.error : `${PROVIDER_FIELDS[e.provider].name}: ${e.error}`)),
      r.issues.length
        ? h('div', { class: 'issues' }, r.issues.map((i) => h('div', { class: 'issue' },
            h('div', { class: 'issue-head' }, h('span', { class: 'pill out' }, PROVIDER_FIELDS[i.provider].name), h('a', { class: 'mono', href: i.url, target: '_blank', rel: 'noopener' }, i.key), h('b', {}, i.title)),
            i.body ? h('div', { class: 'small muted issue-body' }, i.body.slice(0, 300)) : '',
            h('div', { class: 'row' }, h('button', { class: 'btn primary sm', onclick: () => takeIssue(i) }, 'Взять в работу')))))
        : h('p', { class: 'muted small' }, 'Открытых задач нет.'),
    );
  } catch (e) { box.replaceChildren(h('div', { class: 'err' }, e.message)); }
}
$('refreshIssues').addEventListener('click', loadIssues);

function takeIssue(i) {
  pendingIssue = { provider: i.provider, id: i.id, key: i.key, url: i.url, title: i.title };
  setGoal(`${i.title}${i.body ? `\n\n${i.body.slice(0, 1500)}` : ''}`);
  renderIssueInfo();
  show('run');
}

function renderIssueInfo() {
  const el = $('issueInfo');
  if (!pendingIssue) { el.hidden = true; return; }
  el.hidden = false;
  el.replaceChildren(`Цель взята из задачи ${pendingIssue.key} (${PROVIDER_FIELDS[pendingIssue.provider].name}) — итог можно будет записать в неё.`, h('button', { class: 'btn', onclick: () => { pendingIssue = null; renderIssueInfo(); } }, 'Отвязать'));
}

/** Блок «Отправить» в итоге прогона: push, PR/MR, итог в задачу. */
const metaCache = {};
function publishBlock(target) {
  const wrap = h('div', { class: 'publish' });
  const key = `${target.repo}|${target.id}`;
  const draw = (meta) => {
    const status = h('div', { class: 'publish-status' });
    const say = (steps) => status.replaceChildren(...steps.map((s) => h('div', { class: `status-line ${s.ok ? 'ok' : 'bad'}` }, s.message)));
    const run = async (opts, btn) => {
      btn.disabled = true;
      try { const r = await api('/api/publish', { ...target, ...opts }); say(r.steps); metaCache[key] = { ...meta, published: r.published }; } catch (e) { say([{ ok: false, message: e.message }]); }
      btn.disabled = false;
    };
    const hasGit = intConfig.github || intConfig.gitlab;
    const prBtn = h('button', { class: 'btn sm', onclick: (ev) => run({ pr: true }, ev.currentTarget) }, 'Отправить ветку и открыть PR/MR');
    const pushBtn = h('button', { class: 'btn sm', onclick: (ev) => run({ push: true }, ev.currentTarget) }, 'Только отправить ветку');
    const commentBtn = meta.issue ? h('button', { class: 'btn sm', onclick: (ev) => run({ comment: true }, ev.currentTarget) }, `Записать итог в ${meta.issue.key}`) : '';
    const pub = meta.published || {};
    wrap.replaceChildren(
      h('div', { class: 'small' }, h('b', {}, 'Отправить: '), meta.issue ? h('span', {}, 'задача ', h('a', { href: meta.issue.url, target: '_blank', rel: 'noopener' }, meta.issue.key), '. ') : '', pub.pr ? h('span', {}, 'PR: ', h('a', { href: pub.pr, target: '_blank', rel: 'noopener' }, pub.pr)) : ''),
      h('div', { class: 'row' }, hasGit ? prBtn : pushBtn, commentBtn),
      hasGit ? '' : h('div', { class: 'muted small' }, 'Чтобы открывать PR/MR, подключи GitHub или GitLab в разделе «Подключения».'),
      status,
    );
  };
  if (metaCache[key]) draw(metaCache[key]);
  else api(`/api/changes?repo=${encodeURIComponent(target.repo)}&id=${encodeURIComponent(target.id)}`).then((ch) => { metaCache[key] = ch.meta; draw(ch.meta); }).catch(() => undefined);
  return wrap;
}

// ---------- окна ----------

function modal(title, body) {
  $('modalTitle').textContent = title;
  $('modalBody').replaceChildren(...[].concat(body));
  $('modal').hidden = false;
}
$('modalClose').addEventListener('click', () => { $('modal').hidden = true; });
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('modal').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('modal').hidden = true; });
function alertBox(text) { modal('AgentYard', h('p', {}, text)); }

// ---------- старт ----------

if (!TOKEN) {
  document.body.replaceChildren(h('div', { class: 'card', style: 'margin:40px auto;max-width:560px' }, h('h2', {}, 'Нет токена доступа'), h('p', {}, 'Открой интерфейс по ссылке, которую напечатал сервер в консоли (в ней есть ?t=…).')));
} else {
  api('/api/info').then((i) => {
    INFO = i;
    renderGoalInfo();
  }).catch(() => undefined);
  connect();
  restore().then(() => { renderTop(); if (S.view === 'board') renderBoard(); });
  if (repoInp.value) checkRepo();
  loadModels();
  api('/api/integrations').then((r) => { intConfig = r.config; }).catch(() => undefined);
}
