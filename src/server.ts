// Локальный сервер интерфейса (этап 1).
// Слушает только 127.0.0.1, каждый запрос к API несёт случайный токен — чужие сайты в браузере
// не смогут дёргать конвейер. Интерфейс — статические файлы из ui/, без сборки.
// Electron-оболочка просто открывает этот адрес в своём окне.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeHardware, TIER_TEXT } from './hardware.ts';
import { loadCatalog, findByTag } from './catalog.ts';
import { fitsMemory, isMoE, kvCacheGb, selectTeam } from './team.ts';
import { Stats } from './stats.ts';
import { OllamaRuntime } from './runtime/ollama.ts';
import { Pipeline, isVerifyTask, readRunState, type PipelineResult } from './pipeline.ts';
import { isSmallPlan } from './plan.ts';
import { createDemoRepo, createFeatureRepo, createWebRepo, demoRuntime, detectDemo, featureRuntime, FEATURE_GOAL } from './demo.ts';
import { ensureRepo, gitScope, isRepo, hasUncommitted } from './git.ts';
import { checkReadiness } from './readiness.ts';
import { applyRun, changedFiles, readMeta, runDiff, unapplyRun, writeMeta } from './apply.ts';
import { dropHandoff, handoffChanges, handoffFiles, humanDir, openInEditor, prepareHandoff } from './handoff.ts';
import { PROVIDER_NAMES, allIssues, commentIssue, configPath, loadConfig, openPullRequest, publicConfig, pushBranch, runSummary, saveProvider, type ProviderId } from './integrations.ts';
import { SCENARIOS, appendHistory, readHistory, renderEval, runEval, trendText, type EvalRow } from './eval.ts';
import { AGENT } from './config.ts';
import type { Runtime } from './runtime/types.ts';
import type { Hardware, LiveEvent, Plan } from './types.ts';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');

export interface ServerOptions {
  port?: number;
  /** Подменить рантайм (тесты). По умолчанию — Ollama или учебная модель по флагу mock. */
  runtimeFactory?: (mock: boolean, goal: string) => Runtime;
  hardware?: () => Promise<Hardware>;
  /** Не писать статистику в домашнюю папку (тесты). */
  statsPath?: string | null;
  token?: string;
  /** Куда складывать экзамены (тесты). */
  evalRoot?: string;
}

/** Что сервер отдаёт интерфейсу как событие (сверх событий конвейера). */
type UiEvent =
  | LiveEvent
  | { kind: 'run-begin'; runId: string; repo: string; goal: string; mock: boolean }
  | { kind: 'plan'; plan: Plan; warnings: string[] }
  | { kind: 'result'; result: PipelineResult }
  | { kind: 'error'; message: string }
  | { kind: 'pull'; tag: string; text: string; done?: boolean; error?: string }
  | { kind: 'eval'; state: unknown; trend?: string; error?: string }
  | { kind: 'human'; taskId: string; state: 'queued' | 'checking' | 'error'; message: string };

interface RunState {
  runId: string;
  repo: string;
  goal: string;
  mock: boolean;
  pipeline: Pipeline;
  events: UiEvent[];
  approval: ((ok: boolean) => void) | null;
  finished: boolean;
  done?: Promise<unknown>;
}

export interface StartedServer {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
  /** Перед выходом: остановить идущий прогон и дождаться, пока он выгрузит модели из видеопамяти. */
  shutdown: () => Promise<void>;
}

export async function startServer(opts: ServerOptions = {}): Promise<StartedServer> {
  const token = opts.token ?? randomBytes(18).toString('base64url');
  const clients = new Set<http.ServerResponse>();
  let run: RunState | null = null;
  let shuttingDown = false;

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    if (!run || run.finished) return;
    if (run.approval) run.approval(false);
    else run.pipeline.stop();
    // прогон сам выгружает модели в конце; ждём, но не вечно
    await Promise.race([run.done?.catch(() => undefined), new Promise((r) => setTimeout(r, 25_000))]);
  }
  let lastRun: RunState | null = null;
  const pulls = new Map<string, string>();
  const catalog = loadCatalog();
  const getHw = opts.hardware ?? probeHardware;

  const broadcast = (e: UiEvent) => {
    const target = run ?? lastRun;
    if (target && e.kind !== 'pull') {
      // снимков задач много — храним только последний, остальное целиком
      if (e.kind === 'tasks') {
        const i = target.events.findIndex((x) => x.kind === 'tasks');
        if (i >= 0) target.events.splice(i, 1);
      }
      // «что сейчас» обновляется раз в секунду — храним только последнее по каждой дорожке
      if (e.kind === 'activity') {
        const i = target.events.findIndex((x) => x.kind === 'activity' && x.lane === e.lane);
        if (i >= 0) target.events.splice(i, 1);
      }
      target.events.push(e);
      if (target.events.length > 5000) target.events.splice(0, target.events.length - 5000);
    }
    const data = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of clients) c.write(data);
  };

  const makeRuntime =
    opts.runtimeFactory ?? ((mock: boolean, goal: string) => (mock ? (goal === FEATURE_GOAL ? featureRuntime() : demoRuntime()) : new OllamaRuntime()));

  // ---------- обработчики API ----------

  async function models() {
    const hw = await getHw();
    const ollama = new OllamaRuntime();
    const online = await ollama.ping();
    const installed = online ? await ollama.listInstalled().catch(() => []) : [];
    const rows = catalog.map((m) => {
      const fit = fitsMemory(m, hw, AGENT.defaultContext)
        ? 'yes'
        : fitsMemory(m, hw, AGENT.defaultContext, true)
          ? isMoE(m)
            ? 'moe-offload'
            : 'offload'
          : 'no';
      return {
        id: m.id,
        tag: m.ollamaTag,
        params: m.paramsTotalB,
        active: m.paramsActiveB,
        gb: Math.round((m.memoryGbQ4 + kvCacheGb(AGENT.defaultContext)) * 10) / 10,
        license: m.license,
        legacy: !!m.legacy,
        fit,
        installed: installed.some((i) => findByTag(catalog, i.tag)?.id === m.id),
        roles: m.roles,
        pulling: pulls.get(m.ollamaTag) ?? null,
      };
    });
    let team: string[] = [];
    try {
      const inst = installed.map((i) => findByTag(catalog, i.tag)).filter((x): x is NonNullable<typeof x> => !!x);
      if (inst.length) team = selectTeam(inst, hw, new Stats(opts.statsPath === undefined ? undefined : opts.statsPath)).models.map((m) => m.ollamaTag);
    } catch {
      /* бригада не собирается — покажем пустую */
    }
    return { hw, tierText: TIER_TEXT[hw.tier], online, rows, team, otherInstalled: installed.filter((i) => !findByTag(catalog, i.tag)).map((i) => i.tag) };
  }

  function startPull(tag: string) {
    if (pulls.has(tag)) return;
    pulls.set(tag, 'старт');
    const ollama = new OllamaRuntime();
    ollama
      .pull(tag, (text) => {
        pulls.set(tag, text);
        broadcast({ kind: 'pull', tag, text });
      })
      .then(() => broadcast({ kind: 'pull', tag, text: 'готово', done: true }))
      .catch((e: Error) => broadcast({ kind: 'pull', tag, text: 'ошибка', done: true, error: e.message }))
      .finally(() => pulls.delete(tag));
  }

  async function checkRepo(dir: string) {
    const abs = path.resolve(dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return { path: abs, exists: false, repo: false, dirty: false, runs: [], demo: null, hasTests: false, readiness: [] };
    const repo = await isRepo(abs);
    const pkg = path.join(abs, 'package.json');
    let hasTests = existsSync(path.join(abs, 'pytest.ini')) || existsSync(path.join(abs, 'pyproject.toml'));
    if (existsSync(pkg)) {
      try {
        const t = (JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> }).scripts?.test ?? '';
        hasTests = !!t && !/no test specified/.test(t);
      } catch {
        /* битый package.json */
      }
    }
    const scope = repo ? await gitScope(abs) : null;
    const runs = [...listRuns(abs), ...(scope ? listRuns(scope.root) : [])].sort((a, b) => b.id.localeCompare(a.id));
    return { path: abs, exists: true, repo, dirty: repo ? await hasUncommitted(abs) : false, runs, demo: detectDemo(abs), hasTests, readiness: checkReadiness(abs, repo) };
  }

  async function startRun(body: Record<string, unknown>, fromEval = false): Promise<{ runId: string; done: Promise<PipelineResult> }> {
    if (run && !run.finished) throw new HttpError(409, 'Уже идёт прогон. Дождись конца или нажми «Стоп».');
    if (evalState?.running && !fromEval) throw new HttpError(409, 'Идёт экзамен — дождись его конца.');
    let repo = path.resolve(String(body.repo ?? ''));
    let goal = String(body.goal ?? '').trim();
    if (!body.repo || !goal) throw new HttpError(400, 'Нужны папка проекта и цель.');
    if (goal === 'shop-demo') goal = FEATURE_GOAL;
    const mock = !!body.mock;
    if (!existsSync(repo)) throw new HttpError(400, `Папки нет: ${repo}`);
    const block = checkReadiness(repo, await isRepo(repo)).find((r) => r.level === 'block');
    if (block && !body.force) throw new HttpError(400, block.text);
    if (!(await isRepo(repo))) {
      // конвейер работает в отдельной ветке, чтобы всё можно было откатить — репозиторий создаётся сам
      if (body.initGit === false) throw new HttpError(400, 'Папка не под git, а создавать репозиторий запрещено настройками.');
      await ensureRepo(repo);
    }
    // подпапка большого репозитория (web/ внутри проекта) — работаем от корня репозитория, правки — в этой папке
    const scope = await gitScope(repo);
    if (scope) repo = scope.root;
    const runtime = makeRuntime(mock, goal);
    if (!mock && runtime instanceof OllamaRuntime && !(await runtime.ping())) {
      throw new HttpError(400, 'Ollama не отвечает на 127.0.0.1:11434. Запусти Ollama или включи учебную модель.');
    }
    const hardware = await getHw();
    if (mock) Object.assign(hardware, { gpuName: 'учебный режим', tier: 'T3', vramTotalGb: 48, vramFreeGb: 48 });
    const resume = typeof body.resumeId === 'string' && /^[\w-]+$/.test(body.resumeId);
    const runId = resume ? String(body.resumeId) : new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    // approve: true/'always' — всегда спрашивать; 'big' — только большие планы; false/'never' — не спрашивать
    const approveMode = body.approve === false || body.approve === 'never' ? 'never' : body.approve === 'big' ? 'big' : 'always';
    const askApproval = !resume && approveMode !== 'never';

    const state: RunState = {
      runId,
      repo,
      goal,
      mock,
      events: [],
      approval: null,
      finished: false,
      pipeline: null as unknown as Pipeline,
    };
    state.pipeline = new Pipeline({
      repo,
      focus: scope?.focus,
      goal,
      runtime,
      catalog,
      hardware,
      stats: new Stats(mock ? null : opts.statsPath === undefined ? undefined : opts.statsPath),
      review: body.review !== false,
      autoApply: body.autoApply !== false,
      allowInstall: body.allowInstall !== false,
      allowOffload: !!body.offload,
      numCtx: body.ctx ? Number(body.ctx) : AGENT.defaultContext,
      runId,
      resume,
      humanFixes: Array.isArray(body.humanFixes) ? body.humanFixes.map(String) : undefined,
      retryTasks: Array.isArray(body.retryTasks) ? body.retryTasks.map(String) : undefined,
      humanHints: body.humanHints && typeof body.humanHints === 'object' ? (body.humanHints as Record<string, string>) : undefined,
      humanClose: Array.isArray(body.humanClose) ? body.humanClose.map(String) : undefined,
      rework: typeof body.rework === 'string' ? body.rework : undefined,
      // копилка решений приложения (на учебной модели — только в памяти, чтобы не засорять)
      learnedDir: mock ? null : path.join(path.dirname(UI_DIR), 'skills', 'learned'),
      // при повторяющейся ошибке искать решение в интернете (на учебной модели — нет)
      webLookup: !mock && body.webLookup !== false,
      issue: issueOf(body.issue),
      quiet: true,
      onEvent: (e) => broadcast(e),
      approvePlan: askApproval
        ? (plan, warnings) =>
            approveMode === 'big' && isSmallPlan(plan)
              ? Promise.resolve(true)
              : new Promise<boolean>((resolve) => {
              state.approval = (ok) => {
                state.approval = null;
                resolve(ok);
              };
              broadcast({ kind: 'plan', plan, warnings });
            })
        : undefined,
    });
    if (run) lastRun = run;
    run = state;
    broadcast({ kind: 'run-begin', runId, repo, goal, mock });
    const done = state.pipeline.run();
    state.done = done;
    done
      .then((result) => broadcast({ kind: 'result', result }))
      .catch((e: Error) => broadcast({ kind: 'error', message: e.message }))
      .finally(() => {
        state.finished = true;
        // человек сдал правку в самый конец прогона — доводим продолжением
        const closes = state.pipeline.pendingCloses();
        const pending = state.pipeline.pendingHumanFixes().filter((x) => !closes.includes(x));
        const hints = state.pipeline.pendingHints();
        const retries = state.pipeline.pendingRetries().filter((x) => !(x in hints));
        if (shuttingDown) return;
        if (pending.length || retries.length || closes.length || Object.keys(hints).length) startRun({ repo, goal, resumeId: runId, humanFixes: pending, retryTasks: retries, humanHints: hints, humanClose: closes, approve: 'never', autoApply: body.autoApply !== false, allowInstall: true, mock }).catch(() => undefined);
      });
    return { runId, done };
  }

  // ---------- экзамен («пьяный тест») из окна ----------

  const evalRoot = opts.evalRoot ?? path.join(path.dirname(UI_DIR), 'eval-runs');
  let evalState: { running: boolean; rows: EvalRow[]; current: string | null; total: number; dir: string } | null = null;

  function startEval(body: Record<string, unknown>) {
    if (evalState?.running) throw new HttpError(409, 'Экзамен уже идёт.');
    if (run && !run.finished) throw new HttpError(409, 'Идёт прогон — дождись его конца.');
    const only = Array.isArray(body.only) ? body.only.map(String) : undefined;
    const started = new Date();
    const dir = path.join(evalRoot, started.toISOString().replace(/[-:T]/g, '').slice(0, 14));
    const total = SCENARIOS.filter((sc) => !only?.length || only.includes(sc.id)).length;
    evalState = { running: true, rows: [], current: null, total, dir };
    const state = evalState;
    let models = '';
    broadcast({ kind: 'eval', state: { ...state } });
    runEval(
      dir,
      async (repo, goal) => {
        state.current = path.basename(repo);
        broadcast({ kind: 'eval', state: { ...state } });
        const { done } = await startRun({ repo, goal, approve: false, autoApply: true, allowInstall: true, mock: !!body.mock, review: true }, true);
        const res = await done;
        models ||= /Бригада: (.+)\.$/m.exec(readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8'))?.[1] ?? '';
        return res;
      },
      only,
      () => undefined,
      (row) => {
        state.rows.push(row);
        broadcast({ kind: 'eval', state: { ...state } });
      },
    )
      .then((rows) => {
        writeFileSync(path.join(dir, 'eval.md'), renderEval(rows, { models, started: started.toLocaleString('ru-RU') }));
        writeFileSync(path.join(dir, 'eval.json'), JSON.stringify(rows, null, 2));
        const history = appendHistory(evalRoot, {
          at: started.toISOString(),
          models,
          passed: rows.filter((r) => r.pass).length,
          total: rows.length,
          dir,
          rows: rows.map((r) => ({ id: r.id, pass: r.pass, seconds: Math.round(r.seconds) })),
        });
        state.running = false;
        state.current = null;
        broadcast({ kind: 'eval', state: { ...state }, trend: trendText(history) });
      })
      .catch((e: Error) => {
        state.running = false;
        broadcast({ kind: 'eval', state: { ...state }, error: e.message });
      });
    return { dir, total };
  }

  // ---------- задача у человека: редактор, проверка при сохранении, продолжение ----------

  const watchers = new Map<string, { files: string[]; timer: NodeJS.Timeout | null; mock: boolean; autoApply: boolean }>();

  function taskOf(repo: string, id: string, taskId: string) {
    const st = readRunState(runDir(repo, id));
    if (!st) throw new HttpError(400, 'У этого прогона нет сохранённого состояния — доделать задачу через AgentYard нельзя.');
    const t = st.tasks.find((x) => x.id === taskId);
    if (!t) throw new HttpError(404, `Нет задачи ${taskId}.`);
    return { st, t, why: new Map(st.humanReasons).get(taskId) ?? '' };
  }

  async function humanOpen(body: Record<string, unknown>) {
    const repo = path.resolve(String(body.repo ?? ''));
    const id = String(body.id ?? '');
    const taskId = String(body.taskId ?? '');
    const { t, st } = taskOf(repo, id, taskId);
    const files = handoffFiles(repo, t, st.tasks);
    const h = await prepareHandoff(repo, id, taskId, files);
    const editor = body.editor === false ? { editor: '', ok: true } : openInEditor(h.dir, h.files);
    if (body.watch !== false) watchHandoff(repo, id, taskId, h.files, !!body.mock, body.autoApply !== false);
    return { dir: h.dir, files: h.files, created: h.created, editor: editor.editor, opened: editor.ok, changed: await handoffChanges(h.dir) };
  }

  /** Следим за файлами задачи: сохранил — через 2 секунды проверяем и продолжаем. */
  function watchHandoff(repo: string, id: string, taskId: string, files: string[], mock: boolean, autoApply: boolean) {
    const key = `${repo}|${id}|${taskId}`;
    unwatch(key);
    const w = { files, timer: null as NodeJS.Timeout | null, mock, autoApply };
    watchers.set(key, w);
    for (const f of files) {
      watchFile(f, { interval: 800 }, (cur, prev) => {
        if (cur.mtimeMs === prev.mtimeMs) return;
        if (w.timer) clearTimeout(w.timer);
        w.timer = setTimeout(() => {
          w.timer = null;
          if (!existsSync(humanDir(repo, id, taskId))) return unwatch(key);
          humanSubmit({ repo, id, taskId, mock: w.mock, autoApply: w.autoApply }, true).catch((e: Error) => broadcast({ kind: 'human', taskId, state: 'error', message: e.message }));
        }, 2000);
      });
    }
  }

  function unwatch(key: string) {
    const w = watchers.get(key);
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    for (const f of w.files) unwatchFile(f);
    watchers.delete(key);
  }

  async function humanSubmit(body: Record<string, unknown>, auto = false) {
    const repo = path.resolve(String(body.repo ?? ''));
    const id = String(body.id ?? '');
    const taskId = String(body.taskId ?? '');
    const { st, t } = taskOf(repo, id, taskId);
    const close = body.close === true;
    const changed = await handoffChanges(humanDir(repo, id, taskId));
    if (!changed.length && auto) return { mode: 'nothing' };
    // без правки «Готово» имеет смысл только у проверочной задачи (программа проверит, что всё уже так)
    if (!changed.length && !close && !isVerifyTask(t)) {
      throw new HttpError(400, 'В файлах задачи ничего не изменено. Поправь и сохрани — или нажми «Менять нечего — закрыть», если правка и правда не нужна.');
    }
    if (run && !run.finished) {
      if (run.repo === repo && run.runId === id) {
        if (close) run.pipeline.closeByHuman(taskId);
        else run.pipeline.submitHumanFix(taskId);
        broadcast({ kind: 'human', taskId, state: 'queued', message: close ? 'Закрываю задачу — агенты идут дальше по цепочке.' : 'Проверяю правку сейчас, не дожидаясь текущего шага видеокарты.' });
        return { mode: 'live' };
      }
      throw new HttpError(409, 'Сейчас идёт другой прогон — дождись его конца, правка сохранена и никуда не денется.');
    }
    broadcast({ kind: 'human', taskId, state: 'checking', message: close ? 'Закрываю задачу…' : auto ? 'Файл сохранён — проверяю правку…' : 'Проверяю правку…' });
    await startRun({ repo, goal: st.goal, resumeId: id, ...(close ? { humanClose: [taskId] } : { humanFixes: [taskId] }), approve: 'never', autoApply: body.autoApply !== false, allowInstall: true, mock: !!body.mock });
    return { mode: 'resume' };
  }

  /**
   * «Отправить на доработку»: законченный прогон продолжается — планировщик берёт то, чего не хватает по приёмке,
   * и просьбу человека (если написал), агенты доделывают в той же ветке, результат применяется поверх.
   */
  async function rework(body: Record<string, unknown>) {
    const repo = path.resolve(String(body.repo ?? ''));
    const id = String(body.id ?? '');
    const st = readRunState(runDir(repo, id));
    if (!st) throw new HttpError(400, 'У этого прогона нет сохранённого состояния — доработать его нельзя, запусти новый с этой целью.');
    if (run && !run.finished) throw new HttpError(409, run.repo === repo && run.runId === id ? 'Этот прогон ещё идёт — дождись конца.' : 'Сейчас идёт другой прогон — дождись его конца.');
    const note = String(body.note ?? '').trim().slice(0, 2000);
    await startRun({ repo, goal: st.goal, resumeId: id, rework: note, approve: 'never', autoApply: body.autoApply !== false, allowInstall: true, mock: !!body.mock });
    return { mode: 'resume' };
  }

  /** «Разбить на подзадачи и попробовать без меня»: живому прогону — в очередь, законченному — продолжение. */
  async function humanRetry(body: Record<string, unknown>) {
    const repo = path.resolve(String(body.repo ?? ''));
    const id = String(body.id ?? '');
    const taskId = String(body.taskId ?? '');
    const { st, t } = taskOf(repo, id, taskId);
    if (t.status !== 'human') throw new HttpError(400, `Задача ${taskId} уже не у человека.`);
    if (run && !run.finished) {
      if (run.repo === repo && run.runId === id) {
        run.pipeline.retryHuman(taskId);
        broadcast({ kind: 'human', taskId, state: 'queued', message: 'Передал агентам: задача снова в очереди, начатое доделывается первым — планировщик возьмёт её следующим шагом видеокарты.' });
        return { mode: 'live' };
      }
      throw new HttpError(409, 'Сейчас идёт другой прогон — дождись его конца.');
    }
    await startRun({ repo, goal: st.goal, resumeId: id, retryTasks: [taskId], approve: 'never', autoApply: body.autoApply !== false, allowInstall: true, mock: !!body.mock });
    return { mode: 'resume' };
  }

  /** «Передать агентам с подсказкой»: человек вставил решение — живому прогону сразу, законченному — продолжение. */
  async function humanHint(body: Record<string, unknown>) {
    const repo = path.resolve(String(body.repo ?? ''));
    const id = String(body.id ?? '');
    const taskId = String(body.taskId ?? '');
    const hint = String(body.hint ?? '').trim();
    if (!hint) throw new HttpError(400, 'Напиши подсказку: кусок кода или пару слов, что сделать.');
    const { st, t } = taskOf(repo, id, taskId);
    if (t.status === 'done') throw new HttpError(400, `Задача ${taskId} уже готова.`);
    if (run && !run.finished) {
      if (run.repo === repo && run.runId === id) {
        run.pipeline.hintHuman(taskId, hint);
        broadcast({ kind: 'human', taskId, state: 'queued', message: 'Подсказка передана: исполнитель возьмёт задачу с ней следующим шагом.' });
        return { mode: 'live' };
      }
      throw new HttpError(409, 'Сейчас идёт другой прогон — дождись его конца.');
    }
    await startRun({ repo, goal: st.goal, resumeId: id, humanHints: { [taskId]: hint }, approve: 'never', autoApply: body.autoApply !== false, allowInstall: true, mock: !!body.mock });
    return { mode: 'resume' };
  }

  // ---------- доски и git ----------

  async function publish(body: Record<string, unknown>) {
    const repo = path.resolve(String(body.repo ?? ''));
    const id = String(body.id ?? '');
    const meta = readMeta(repo, id);
    if (!meta) throw new HttpError(404, 'Прогон не дошёл до конца — отправлять нечего.');
    const cfg = loadConfig();
    const files = await changedFiles(repo, meta);
    const events = readJsonl(path.join(runDir(repo, id), 'events.jsonl')) as { event: { type: string; goal?: string; achieved?: boolean | null; missing?: string[] } }[];
    const goal = events.find((e) => e.event.type === 'run-start')?.event.goal ?? '';
    const gc = events.filter((e) => e.event.type === 'goal-check').at(-1)?.event;
    const steps: { step: string; ok: boolean; message: string }[] = [];
    const published = { ...(meta.published ?? {}), at: new Date().toISOString() };
    if (body.push || body.pr) {
      try {
        await pushBranch(repo, meta.branch);
        published.pushed = meta.branch;
        steps.push({ step: 'push', ok: true, message: `Ветка ${meta.branch} отправлена в origin.` });
      } catch (e) {
        steps.push({ step: 'push', ok: false, message: (e as Error).message });
      }
    }
    if (body.pr && published.pushed) {
      try {
        const title = meta.issue ? `${meta.issue.key} ${meta.issue.title}` : `AgentYard: ${goal.slice(0, 80)}`;
        const pr = await openPullRequest({ repo, branch: meta.branch, base: meta.target, title, body: `${runSummary({ goal, done: meta.done, human: meta.human, files, goalCheck: gc ? { achieved: gc.achieved ?? null, missing: gc.missing } : null, branch: meta.branch })}${meta.issue ? `\n\nЗадача: ${meta.issue.url}` : ''}`, cfg });
        published.pr = pr.url;
        steps.push({ step: 'pr', ok: true, message: `${pr.kind} открыт: ${pr.url}` });
      } catch (e) {
        steps.push({ step: 'pr', ok: false, message: (e as Error).message });
      }
    }
    if (body.comment) {
      if (!meta.issue) steps.push({ step: 'comment', ok: false, message: 'Этот прогон запущен не из задачи с доски — комментировать некуда.' });
      else {
        try {
          await commentIssue({ provider: meta.issue.provider as ProviderId, id: meta.issue.id }, runSummary({ goal, done: meta.done, human: meta.human, files, goalCheck: gc ? { achieved: gc.achieved ?? null, missing: gc.missing } : null, branch: meta.branch, pr: published.pr }), cfg, repo);
          published.commented = meta.issue.url;
          steps.push({ step: 'comment', ok: true, message: `Итог записан в задачу ${meta.issue.key}.` });
        } catch (e) {
          steps.push({ step: 'comment', ok: false, message: (e as Error).message });
        }
      }
    }
    writeMeta(repo, { ...meta, published });
    return { steps, published };
  }

  // ---------- HTTP ----------

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      // защита от подмены DNS: принимаем только локальные имена
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return send(res, 403, { error: 'host' });

      if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);

      const given = req.headers['x-ay-token'] ?? url.searchParams.get('t');
      if (given !== token) return send(res, 401, { error: 'Нет токена доступа: открой интерфейс по ссылке, которую напечатал сервер.' });

      const body = req.method === 'POST' ? await readJson(req) : {};
      const q = (k: string) => url.searchParams.get(k) ?? '';
      // прогоны в подпапке репозитория (web/) лежат в корне репозитория — история, отчёт, применение ищут их там
      if (!['/api/repo', '/api/run', '/api/demo'].includes(url.pathname)) {
        const id = String(body.id ?? body.runId ?? q('id') ?? '');
        if (typeof body.repo === 'string' && body.repo) body.repo = await resolveRepo(body.repo, id);
        if (url.searchParams.get('repo')) url.searchParams.set('repo', await resolveRepo(q('repo'), id));
      }

      switch (`${req.method} ${url.pathname}`) {
        case 'GET /api/models':
          return send(res, 200, await models());
        case 'POST /api/models/pull':
          startPull(String(body.tag ?? ''));
          return send(res, 200, { ok: true });
        case 'GET /api/repo':
          return send(res, 200, await checkRepo(q('path')));
        case 'GET /api/info':
          return send(res, 200, { appDir: path.dirname(UI_DIR), shopGoal: FEATURE_GOAL });
        case 'POST /api/demo': {
          const kind = body.kind === 'shop' ? 'shop' : body.kind === 'web' ? 'web' : 'fix';
          const dir = path.resolve(String(body.dir ?? ''));
          const goal = kind === 'shop' ? FEATURE_GOAL : kind === 'web' ? 'сделай кнопки красными' : 'fix-tests';
          // уже создан раньше — просто выбираем его
          if (existsSync(dir) && detectDemo(dir) === kind) return send(res, 200, { path: dir, goal, existed: true });
          if (kind === 'shop') createFeatureRepo(dir);
          else if (kind === 'web') createWebRepo(dir);
          else createDemoRepo(dir);
          return send(res, 200, { path: dir, goal, existed: false });
        }
        case 'POST /api/run': {
          const { runId } = await startRun(body);
          return send(res, 200, { runId });
        }
        case 'POST /api/resume': {
          const repo = path.resolve(String(body.repo ?? ''));
          const id = String(body.id ?? '');
          const st = readRunState(runDir(repo, id));
          if (!st) throw new HttpError(400, 'Этот прогон нельзя продолжить: он прервался до начала работы.');
          const { runId } = await startRun({ ...body, repo, goal: st.goal, resumeId: id });
          return send(res, 200, { runId });
        }
        case 'POST /api/eval':
          return send(res, 200, startEval(body));
        case 'GET /api/eval':
          return send(res, 200, { state: evalState, history: readHistory(evalRoot), scenarios: SCENARIOS.map((sc) => ({ id: sc.id, goal: sc.goal, intent: sc.intent })), trend: trendText(readHistory(evalRoot)) });
        case 'POST /api/approve': {
          if (!run?.approval) throw new HttpError(409, 'Сейчас нечего утверждать.');
          run.approval(!!body.ok);
          return send(res, 200, { ok: true });
        }
        case 'POST /api/stop': {
          if (!run || run.finished) throw new HttpError(409, 'Прогон не идёт.');
          if (run.approval) run.approval(false);
          else run.pipeline.stop();
          return send(res, 200, { ok: true });
        }
        case 'POST /api/shutdown': {
          await shutdown();
          return send(res, 200, { ok: true });
        }
        case 'GET /api/current': {
          const r = run ?? lastRun;
          return send(res, 200, r ? { runId: r.runId, repo: r.repo, goal: r.goal, mock: r.mock, finished: r.finished, awaitingApproval: !!r.approval, events: r.events } : null);
        }
        case 'GET /api/events': {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
          res.write(': ok\n\n');
          clients.add(res);
          const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
          req.on('close', () => {
            clearInterval(ping);
            clients.delete(res);
          });
          return;
        }
        case 'GET /api/runs':
          return send(res, 200, listRuns(path.resolve(q('repo'))));
        case 'GET /api/run': {
          const dir = runDir(q('repo'), q('id'));
          const events = readJsonl(path.join(dir, 'events.jsonl'));
          const tasksFile = path.join(dir, 'tasks.json');
          const tasks = existsSync(tasksFile) ? JSON.parse(readFileSync(tasksFile, 'utf8')) : null;
          const tr = path.join(dir, 'transcripts');
          const transcripts = existsSync(tr) ? readdirSync(tr).sort() : [];
          const jf = path.join(dir, 'journal.txt');
          const lines = existsSync(jf) ? readFileSync(jf, 'utf8').split(/\r?\n/).filter(Boolean) : [];
          return send(res, 200, { id: q('id'), events, lines, tasks, transcripts, hasReport: existsSync(path.join(dir, 'report.html')) });
        }
        case 'GET /api/report': {
          const file = path.join(runDir(q('repo'), q('id')), 'report.html');
          if (!existsSync(file)) throw new HttpError(404, 'Отчёта нет — прогон не дошёл до конца.');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(readFileSync(file));
        }
        case 'GET /api/changes': {
          const meta = readMeta(q('repo'), q('id'));
          if (!meta) throw new HttpError(404, 'Прогон не дошёл до конца — изменений нет.');
          return send(res, 200, { meta, files: await changedFiles(path.resolve(q('repo')), meta) });
        }
        case 'GET /api/diff': {
          const meta = readMeta(q('repo'), q('id'));
          if (!meta) throw new HttpError(404, 'Прогон не дошёл до конца — изменений нет.');
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end(await runDiff(path.resolve(q('repo')), meta));
        }
        case 'POST /api/apply':
          return send(res, 200, await applyRun(path.resolve(String(body.repo ?? '')), String(body.id ?? '')));
        case 'POST /api/unapply':
          return send(res, 200, await unapplyRun(path.resolve(String(body.repo ?? '')), String(body.id ?? '')));
        case 'POST /api/human/open':
          return send(res, 200, await humanOpen(body));
        case 'POST /api/rework':
          return send(res, 200, await rework(body));
        case 'POST /api/human/retry':
          return send(res, 200, await humanRetry(body));
        case 'POST /api/human/hint':
          return send(res, 200, await humanHint(body));
        case 'POST /api/human/done':
          return send(res, 200, await humanSubmit(body));
        case 'GET /api/human/status': {
          const dir = humanDir(q('repo'), q('id'), q('taskId'));
          const key = `${path.resolve(q('repo'))}|${q('id')}|${q('taskId')}`;
          let files: string[] = [];
          try {
            const { t, st } = taskOf(path.resolve(q('repo')), q('id'), q('taskId'));
            files = handoffFiles(path.resolve(q('repo')), t, st.tasks).map((f) => path.join(dir, f));
          } catch {
            /* состояния нет — покажем папку */
          }
          return send(res, 200, { exists: existsSync(dir), dir, files, changed: await handoffChanges(dir), watching: watchers.has(key) });
        }
        case 'POST /api/human/drop': {
          const repo = path.resolve(String(body.repo ?? ''));
          unwatch(`${repo}|${String(body.id)}|${String(body.taskId)}`);
          await dropHandoff(repo, String(body.id ?? ''), String(body.taskId ?? ''));
          return send(res, 200, { ok: true });
        }
        case 'GET /api/integrations':
          return send(res, 200, { config: publicConfig(loadConfig()), providers: PROVIDER_NAMES, file: configPath() });
        case 'POST /api/integrations': {
          const provider = String(body.provider ?? '') as ProviderId;
          if (!(provider in PROVIDER_NAMES)) throw new HttpError(400, 'Нет такой доски.');
          const settings = body.settings === null ? null : (body.settings as Record<string, string>) ?? {};
          return send(res, 200, { config: publicConfig(saveProvider(provider, settings)) });
        }
        case 'GET /api/issues':
          return send(res, 200, await allIssues(loadConfig(), q('repo') ? path.resolve(q('repo')) : undefined));
        case 'POST /api/publish':
          return send(res, 200, await publish(body));
        case 'GET /api/transcript': {
          const name = path.basename(q('name'));
          const file = path.join(runDir(q('repo'), q('id')), 'transcripts', name);
          if (!existsSync(file)) throw new HttpError(404, 'Нет такой переписки.');
          return send(res, 200, JSON.parse(readFileSync(file, 'utf8')));
        }
        default:
          return send(res, 404, { error: 'нет такого адреса' });
      }
    } catch (e) {
      const err = e as Error & { status?: number };
      return send(res, err.status ?? 500, { error: err.message });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    port,
    token,
    shutdown,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) c.end();
        server.close(() => resolve());
      }),
  };
}

// ---------- помощники ----------

function issueOf(v: unknown): { provider: string; id: string; key: string; url: string; title: string } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (!(String(o.provider) in PROVIDER_NAMES) || !o.id) return undefined;
  return { provider: String(o.provider), id: String(o.id), key: String(o.key ?? o.id), url: String(o.url ?? ''), title: String(o.title ?? '') };
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new HttpError(413, 'слишком большой запрос'));
    });
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        reject(new HttpError(400, 'тело запроса — не JSON'));
      }
    });
  });
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function serveStatic(res: http.ServerResponse, pathname: string): void {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(UI_DIR, path.normalize(rel));
  if (!file.startsWith(UI_DIR) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'нет файла' });
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(readFileSync(file));
}

function runDir(repo: string, id: string): string {
  if (!/^[\w-]+$/.test(id)) throw new HttpError(400, 'плохой id прогона');
  return path.join(path.resolve(repo), '.agentyard', 'runs', id);
}

function readJsonl(file: string): unknown[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Прошлые прогоны проекта: цель, итог, время. */
/** Папка, где лежат прогоны: сама папка, если прогон там есть, иначе корень git-репозитория, в котором она лежит. */
async function resolveRepo(repo: string, id = ''): Promise<string> {
  const abs = path.resolve(repo);
  if (id && /^[\w-]+$/.test(id) && existsSync(path.join(abs, '.agentyard', 'runs', id))) return abs;
  if (!existsSync(abs)) return abs;
  const scope = await gitScope(abs);
  return scope ? scope.root : abs;
}

export function listRuns(repo: string): { id: string; goal: string; done: number | null; human: number | null; seconds: number | null; resumable: boolean; finished: boolean; applied: string | null; issue: { key: string; url: string } | null; pr: string | null }[] {
  const dir = path.join(repo, '.agentyard', 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /^[\w-]+$/.test(n))
    .sort()
    .reverse()
    .slice(0, 50)
    .map((id) => {
      const ev = readJsonl(path.join(dir, id, 'events.jsonl')) as { event: { type: string; goal?: string; done?: number; human?: number; seconds?: number } }[];
      const start = ev.find((e) => e.event.type === 'run-start')?.event;
      const end = ev.find((e) => e.event.type === 'run-end')?.event;
      let meta: { applied?: { at: string }; issue?: { key: string; url: string }; published?: { pr?: string } } | null = null;
      try {
        meta = existsSync(path.join(dir, id, 'run.json')) ? JSON.parse(readFileSync(path.join(dir, id, 'run.json'), 'utf8')) : null;
      } catch {
        /* битый run.json */
      }
      // последний итог (прогон могли продолжать: ручная правка, сбой)
      const ends = ev.filter((e) => e.event.type === 'run-end');
      const last = ends.at(-1)?.event ?? end;
      return {
        id,
        goal: start?.goal ?? '',
        done: last?.done ?? null,
        human: last?.human ?? null,
        seconds: last?.seconds ?? null,
        resumable: !end && existsSync(path.join(dir, id, 'state.json')),
        finished: !!meta,
        applied: meta?.applied?.at ?? null,
        issue: meta?.issue ? { key: meta.issue.key, url: meta.issue.url } : null,
        pr: meta?.published?.pr ?? null,
      };
    });
}
