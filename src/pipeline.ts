// Главный цикл конвейера: уровни 1–6 вместе.
// Видеокарта — одна модель за раз; процессор — проверки других задач параллельно.

import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { AGENT, BATCH, CPU_LANE, ESCALATION, SAMPLING, TIER_LIMITS } from './config.ts';
import { findByTag, unknownModel } from './catalog.ts';
import { selectTeam, fitsMemory, canRun } from './team.ts';
import { TaskGraph } from './graph.ts';
import { validatePlan } from './plan.ts';
import { isFixTestsGoal, planFixTests, planWithModel, splitWithModel } from './planner.ts';
import { chooseNext, type Pick as DispatchPick, type WorkItem } from './dispatcher.ts';
import { conveyorPick, started } from './conveyor.ts';
import { canGoDirect, inputBudget, progressText, runAgent, runDirect, type AgentResult, type TaskContext } from './agent.ts';
import { countErrorKeys, doneWhenProblems, errorLines, newErrors, runCascade, runCommand, type CommandResult } from './checks.ts';
import { BaselineRunner, compareOutcomes } from './engine/baseline.ts';
import { dependencyDirs, isProjectWide, nodeDirFor, scopedCommands, testCommandsFor } from './engine/workspace.ts';
import { missingPackages, triage } from './engine/triage.ts';
import { decide, stageOf, type AttemptLog } from './engine/policy.ts';
import { describeStumble } from './engine/stumble.ts';
import { chunkText, extractText } from './engine/extract.ts';
import { detectStacks, combinedCommands } from './stacks.ts';
import { DecisionLog, extractFacts, fixKey, type Decision, type FileChange } from './decisions.ts';
import { applyRules, fits, learnRules, markersOf, rulesDoneWhen, rulesSteps, rulesSummary, type RuleSet } from './rules.ts';
import { classify, fileTemplate } from './pools.ts';
import { errorQuery, libraryOfError, localTypeHelp, packagesOfHelp, pageExcerpt, propsFromError, typeNamesFromError, webSearch } from './lookup.ts';
import { isCheckCommand, isRedundantCheck } from './plan.ts';
import { SolutionBook, cleanError, exampleFromDiff, sectionOf, solutionId, tagsFor, titleFor } from './learned.ts';
import { importedPackages } from './lookup.ts';
import { buildRepoMap, renderRepoMap, type ProjectCommands, type RepoMap } from './repomap.ts';
import { Workspace, bisectFirstBad, git } from './git.ts';
import { Journal } from './journal.ts';
import { goalTerms, renderHits, searchRepo } from './context.ts';
import { pickRecipes } from './recipes.ts';
import { entityPairs, matchFiles } from './replicate.ts';
import { addDependencies, dependencyVersions, installPackages, pkgName } from './install.ts';
import { ASSET_RE } from './tools/patch.ts';
import { colorFacts, cssOverrideWarnings } from './css.ts';
import { listFiles } from './tools/fs.ts';
import { checkGoal, normalizeFollowUps, type GoalVerdict } from './goalcheck.ts';
import { applyRun, changedFiles, readMeta, writeMeta, type ApplyResult, type ChangedFile } from './apply.ts';
import { dropHandoff, handoffChanges, humanBranch, humanDir } from './handoff.ts';
import type { Runtime } from './runtime/types.ts';
import type { Stats } from './stats.ts';
import type { CatalogModel, CheckResult, Hardware, LiveEvent, Plan, PlannedTask, Role, Task, TaskView, Team } from './types.ts';

export interface PipelineOptions {
  repo: string;
  /** Цель обычными словами или "fix-tests". */
  goal: string;
  runtime: Runtime;
  catalog: CatalogModel[];
  hardware: Hardware;
  stats: Stats;
  planFile?: string;
  review?: boolean;
  allowOffload?: boolean;
  numCtx?: number;
  runId?: string;
  quiet?: boolean;
  /** Точка контроля №1: утверждение плана человеком. */
  approvePlan?: (plan: Plan, warnings: string[]) => Promise<boolean>;
  /** Живые события для интерфейса: журнал, статусы задач, фазы. */
  onEvent?: (e: LiveEvent) => void;
  /** Сразу влить результат в ветку пользователя, если всё сделано без человека (отменяется кнопкой). */
  autoApply?: boolean;
  /** Разрешено ставить пакеты npm, которые просит план. */
  allowInstall?: boolean;
  /** Продолжить прерванный прогон runId (план и сделанное берутся из его state.json). */
  resume?: boolean;
  /** Задачи, которые человек доделал руками в своей рабочей копии (см. handoff.ts): проверить, влить, идти дальше. */
  humanFixes?: string[];
  /** Задачи у человека, которые он попросил разбить на подзадачи и попробовать ещё раз без него. */
  retryTasks?: string[];
  /** Сколько вариантов правки просить у модели на повторе после своей ошибки (1 — без вариантов). По умолчанию SAMPLING.candidates. */
  sampling?: number;
  /** Подсказки человека к задачам (продолжение законченного прогона): id → решение или кусок кода. */
  humanHints?: Record<string, string>;
  /** «Отправить на доработку»: продолжить законченный прогон — доделать то, чего не хватает по приёмке, и просьбу человека (может быть пустой). */
  rework?: string;
  /** Задачи, которые человек закрыл кнопкой «Менять нечего». */
  humanClose?: string[];
  /** Папка копилки решений (skills/learned). Не задана — копилка только в памяти этого прогона. */
  learnedDir?: string | null;
  /** При повторяющейся ошибке искать решение в интернете (типы библиотек смотрятся всегда, без сети). */
  webLookup?: boolean;
  /** Задача с доски, из которой взята цель (для итога в задачу и PR). */
  issue?: { provider: string; id: string; key: string; url: string; title: string };
}

export interface PipelineResult {
  runDir: string;
  branch: string;
  done: string[];
  human: { id: string; why: string }[];
  reportPath: string;
  swaps: number;
  seconds: number;
  /** Что изменено в проекте относительно старта. */
  changes: ChangedFile[];
  /** Результат доставки в ветку пользователя (если просили). */
  applied?: ApplyResult;
  /** Как понята цель и что сказала приёмка по цели. */
  understanding?: string;
  goal?: { achieved: boolean | null; missing: string[] };
}

/** Процессорная дорожка: ограниченное число параллельных фоновых задач. */
class CpuLane {
  private limit: number;
  private running = 0;
  private queue: (() => void)[] = [];
  private pending = new Set<Promise<void>>();

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  run(job: () => Promise<void>): void {
    const p = new Promise<void>((resolve) => {
      const start = () => {
        this.running += 1;
        job()
          .catch((e) => console.error('Ошибка в фоновой проверке:', e))
          .finally(() => {
            this.running -= 1;
            this.queue.shift()?.();
            resolve();
          });
      };
      if (this.running < this.limit) start();
      else this.queue.push(start);
    });
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
  }

  size(): number {
    return this.pending.size;
  }

  async waitAny(): Promise<void> {
    if (this.pending.size) await Promise.race(this.pending);
  }

  async waitAll(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
}

/** Пул однотипных задач с одним решением. */
export interface PoolMeta {
  id: string;
  /** Задача-образец: остальные ждут её слияния. */
  leader: string;
  members: string[];
  /** Сколько раз образец сменился, потому что прежний не получился. */
  promotions: number;
  glob?: string;
}

/** Простая очередь-замок: слияния в ветку сборки идут строго по одному. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export class Pipeline {
  private o: Required<Pick<PipelineOptions, 'review' | 'allowOffload' | 'numCtx'>> & PipelineOptions;
  private journal!: Journal;
  private ws!: Workspace;
  private graph!: TaskGraph;
  private team!: Team;
  private installed: CatalogModel[] = [];
  private map!: RepoMap;
  private mapText = '';
  private loadedTag: string | null = null;
  /** Модели, которые этот прогон грузил или о чём-то спрашивал: в конце их нужно выгрузить. */
  private usedTags = new Set<string>();
  private swaps = 0;
  private batchStartPending = false;
  private cpu: CpuLane;
  private merge = new Mutex();
  private baseSha = new Map<string, string>();
  private commandsRun: string[] = [];
  private humanReasons = new Map<string, string>();
  /** Ручные правки, которые ждут проверки и слияния. */
  private humanQueue: string[] = [];
  /** Сколько задач влито этим запуском (продолжение без единого слияния не зовёт приёмку зря). */
  private mergedHere = 0;
  private runIdNow = '';
  private firstAppliedFrom: string | null = null;
  private startedAt = Date.now();
  private runBase = '';
  private stopRequested = false;
  /** «Стоп» человека: обрывает запросы к моделям сразу (а не ждёт, пока модель допишет — это до 45 минут). */
  private abort = new AbortController();
  /** Сколько запросов к моделям оборвал «Стоп» (задача, чей запрос оборван, откатывается к состоянию до шага). */
  private cutCalls = 0;
  private lastGoal: { achieved: boolean | null; missing: string[] } | undefined;
  private target = '';
  private runDir = '';
  private planNotes: string[] = [];
  /** Пакеты, уже поставленные в этом прогоне: имя → версия. */
  private installed_ = new Map<string, string>();
  private understanding: string | undefined;
  /** Модели, которые Ollama не смогла загрузить: диспетчер их больше не выбирает. */
  private brokenModels = new Map<string, string>();
  /** Паузы перед повторной загрузкой модели после сбоя, мс. */
  loadRetries = [5_000, 15_000];
  /** Видеокарта перестала загружать модели — дальше все модели грузим на процессор. */
  /** Когда видеокарта перестала грузить модели. Через несколько минут пробуем её снова: сбой CUDA бывает временным. */
  private gpuDeadAt = 0;
  /** Видеокарта хоть раз сбоила при загрузке: дальше смены моделей сводим к минимуму. */
  private gpuShaky = false;
  private lastOllamaRestart = 0;
  /** Пакеты встали только с --legacy-peer-deps (peer-зависимости не совпали с проектом). */
  private legacyPeers = false;
  private knownErrors: { lint?: Map<string, number>; typecheck?: Map<string, number> } = {};
  private active: { taskId: string; role: Role; model: string } | null = null;
  /** Журнал принятых решений: идёт вниз (частям), вбок (соседям и пулу) и вверх (при сборке). */
  private decisions = new DecisionLog();
  /** Пулы однотипных задач. */
  private pools = new Map<string, PoolMeta>();
  /** Принятые решения-образцы (diff образца) — задачам, которые их повторяют. */
  private solutions = new Map<string, string>();
  /** Копилка решений: как уже справлялись с ошибками (skills/learned/<раздел>.md). */
  private book!: SolutionBook;
  /** Задачи, которые прямо сейчас делает программа повтором решения: модели их не берут. */
  private tiraging = new Set<string>();
  /** Запуски команд проверки на исходном состоянии прогона: задача отвечает только за новые падения. */
  private baseRunner = new BaselineRunner((cmd) => this.runOnBase(cmd));
  private baseDir: Promise<string> | null = null;
  private notedBase = new Set<string>();

  constructor(options: PipelineOptions) {
    this.o = { review: true, allowOffload: false, numCtx: AGENT.defaultContext, ...options, runtime: this.stoppable(options.runtime) };
    this.book = new SolutionBook(options.learnedDir ?? null);
    this.cpu = new CpuLane(Math.floor(options.hardware.cpuCores * CPU_LANE.coreShare));
  }

  /**
   * Остановка: запрос к модели обрывается сразу, задача, которую он делал, возвращается к состоянию до этого шага
   * (попытка не засчитывается), идущие проверки доделываются, остальное честно уходит человеку — прогон можно продолжить.
   */
  stop(): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.journal?.record({ type: 'stop', active: this.active?.taskId ?? null });
    this.emit({ kind: 'phase', phase: 'stopping', detail: this.active ? `обрываю запрос к ${this.active.model} (${this.active.taskId}) и доделываю идущие проверки` : 'доделываю идущие проверки' });
    this.abort.abort();
  }

  /** Обёртка рантайма: запросы к моделям и загрузка обрываются «Стопом». */
  private stoppable(raw: Runtime): Runtime {
    const signal = this.abort.signal;
    const guard = <T>(p: Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const cut = () => {
          this.cutCalls += 1;
          reject(new StopError());
        };
        if (signal.aborted) {
          p.catch(() => undefined);
          return cut();
        }
        signal.addEventListener('abort', cut, { once: true });
        p.then(
          (v) => {
            signal.removeEventListener('abort', cut);
            resolve(v);
          },
          (e) => {
            signal.removeEventListener('abort', cut);
            reject(e);
          },
        );
      });
    return {
      get name() {
        return raw.name;
      },
      listInstalled: () => raw.listInstalled(),
      loaded: () => raw.loaded(),
      load: (tag, numCtx, opts) => {
        this.usedTags.add(tag);
        return guard(raw.load(tag, numCtx, opts));
      },
      unload: (tag) => raw.unload(tag),
      chat: (req) => {
        this.usedTags.add(req.model);
        return guard(raw.chat({ ...req, signal: req.signal ?? signal }));
      },
      ...(raw.pull ? { pull: (tag: string, onProgress?: (text: string) => void) => raw.pull!(tag, onProgress) } : {}),
      ...(raw.restart ? { restart: () => raw.restart!() } : {}),
    };
  }

  private emit(e: LiveEvent): void {
    try {
      this.o.onEvent?.(e);
    } catch {
      /* интерфейс не должен ронять конвейер */
    }
  }

  /** Что идёт прямо сейчас — для живой строки в окне. lane: 'gpu' — модель, 'cpu:T1' — проверки задачи. */
  private lanes = new Map<string, { text: string; since: string }>();
  private activity(lane: string, info: { taskId?: string; role?: string; model?: string }, text: string | null, sameAction = false): void {
    if (text === null) this.lanes.delete(lane);
    const prev = this.lanes.get(lane);
    const since = sameAction && prev ? prev.since : new Date().toISOString();
    if (text !== null) this.lanes.set(lane, { text, since });
    this.emit({ kind: 'activity', lane, ...info, text, since });
  }
  private stageReporter(t: Task): (text: string) => void {
    return (text) => this.activity(`cpu:${t.id}`, { taskId: t.id }, `проверки: ${text}`);
  }
  private clearActivity(): void {
    for (const lane of [...this.lanes.keys()]) this.activity(lane, {}, null);
  }

  private emitTasks(): void {
    if (!this.o.onEvent || !this.graph) return;
    this.emit({ kind: 'tasks', tasks: this.taskViews(), active: this.active });
  }

  taskViews(): TaskView[] {
    return this.graph.all().map((t) => ({
      id: t.id,
      type: t.type,
      role: t.role,
      title: t.title,
      brief: t.brief,
      status: t.status,
      dependsOn: [...t.dependsOn],
      files: [...t.files],
      tests: [...t.accept.tests],
      commands: [...t.accept.commands],
      frozen: [...t.frozenFiles],
      attempts: t.attempts,
      ladderStep: t.ladderStep,
      lastError: t.lastError?.slice(0, 3000),
      doneBy: t.doneBy,
      lastModel: t.lastModel,
      humanWhy: this.humanReasons.get(t.id),
      install: t.install,
      steps: t.steps,
      doneWhen: t.doneWhen,
      reference: t.reference?.slice(0, 3000),
      stage: t.stage,
      inputs: t.inputs,
      humanHint: t.humanHint,
      stumble: t.attempts > 0 || t.status === 'human' || t.attemptLog?.length ? (describeStumble(t, this.humanReasons.get(t.id)) ?? undefined) : undefined,
      parent: t.parent,
      children: t.children,
      pool: t.pool,
      poolLeader: !!t.pool && this.pools.get(t.pool)?.leader === t.id,
      solutionFrom: t.solutionFrom,
      seq: t.seq,
    }));
  }

  private get limits() {
    return TIER_LIMITS[this.o.hardware.tier];
  }

  // ---------- подготовка: бригада, разведка, план ----------

  async run(): Promise<PipelineResult> {
    try {
      return await this.runAll();
    } finally {
      await this.releaseModels();
    }
  }

  /**
   * Конец прогона (готово, «Стоп», ошибка): модели, с которыми работал прогон, сразу выгружаются из видеопамяти.
   * Без этого Ollama держит их ещё keep_alive минут — видеокарта и память заняты, хотя работы нет.
   * Чужие модели (загруженные другими программами после прогона) не трогаем.
   */
  async releaseModels(): Promise<string[]> {
    if (!this.usedTags.size) return [];
    const full = (t: string) => (t.includes(':') ? t : `${t}:latest`);
    const used = new Set([...this.usedTags].map(full));
    const resident = await this.o.runtime.loaded().catch(() => [] as string[]);
    const mine = resident.filter((t) => used.has(full(t)));
    for (const tag of mine) await this.o.runtime.unload(tag).catch(() => undefined);
    this.loadedTag = null;
    this.usedTags.clear();
    if (mine.length) this.journal?.record({ type: 'self-help', taskId: '—', what: `прогон закончен — выгрузил из видеопамяти: ${mine.join(', ')}` });
    return mine;
  }

  private async runAll(): Promise<PipelineResult> {
    const runId = this.o.runId ?? new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const runDir = path.join(this.o.repo, '.agentyard', 'runs', runId);
    this.journal = new Journal(runDir, this.o.quiet, (st, line) => this.emit({ kind: 'journal', at: st.at, event: st.event, line }));
    this.emit({ kind: 'phase', phase: 'team' });
    this.ws = new Workspace(this.o.repo, runId);

    // Уровень 1: бригада из установленных моделей
    const installed = await this.o.runtime.listInstalled();
    this.installed = installed.map((m) => {
      const known = findByTag(this.o.catalog, m.tag);
      return known ? { ...known, ollamaTag: m.tag } : unknownModel(m.tag, m.sizeGb);
    });
    this.team = selectTeam(this.installed, this.o.hardware, this.o.stats, { allowOffload: this.o.allowOffload });
    this.loadedTag = (await this.o.runtime.loaded())[0] ?? null;

    const hw = this.o.hardware;
    this.journal.record({
      type: 'run-start',
      goal: this.o.goal,
      repo: this.o.repo,
      tier: hw.tier,
      hardware: `${hw.gpuName ?? 'без видеокарты'}, ${hw.vramTotalGb} ГБ видеопамяти, ${hw.ramTotalGb} ГБ RAM`,
      team: this.team.models.map((m) => m.ollamaTag),
    });

    this.emit({ kind: 'phase', phase: 'map', team: this.team.models.map((m) => m.ollamaTag) });
    // Разведка без модели
    this.map = buildRepoMap(this.o.repo);
    this.mapText = renderRepoMap(this.map);
    // части проекта (backend/ + web/): ссылки на зависимости в рабочих копиях — в папке каждой части
    this.ws.depDirs = dependencyDirs(this.map.stacks);

    await this.baseline();

    let target: string;
    if (this.o.resume) {
      // продолжение: план и сделанное — из сохранённого состояния, ветка сборки уже есть
      const st = readRunState(runDir);
      if (!st) throw new Error('Этот прогон нельзя продолжить: он прервался раньше, чем начал работу (нет state.json). Запусти заново.');
      target = st.target;
      this.runBase = st.base;
      this.understanding = st.understanding;
      for (const [id, why] of st.humanReasons) this.humanReasons.set(id, why);
      for (const [n, v] of st.installed) this.installed_.set(n, v);
      for (const pm of st.pools ?? []) this.pools.set(pm.id, pm);
      for (const [k, v] of st.solutions ?? []) this.solutions.set(k, v);
      this.decisions = DecisionLog.from(st.decisions);
      await this.ws.cleanupStale();
      this.graph = TaskGraph.restore(st.tasks);
      const all = this.graph.all();
      this.journal.record({ type: 'resume', done: all.filter((t) => t.status === 'done').length, left: all.filter((t) => !['done', 'human'].includes(t.status)).length, human: all.filter((t) => t.status === 'human').length });
    } else {
      // Уровень 2: план
      this.emit({ kind: 'phase', phase: 'planning' });
      const plan = await this.makePlan();
      const check = validatePlan(plan, this.o.repo, hw.tier, this.map.commands);
      if (!check.ok) throw new Error(`План не прошёл проверку:\n${check.errors.join('\n')}`);
      if (check.plan.tasks.length === 0) {
        throw new Error(
          isFixTestsGoal(this.o.goal)
            ? 'Делать нечего: цель «fix-tests» чинит падающие тесты, а в этом проекте все тесты уже проходят. Напиши в цели, что нужно добавить или изменить.'
            : 'План пуст: планировщик не нашёл, что делать. Уточни цель: какой файл, какая функция, какое поведение.',
        );
      }
      this.journal.record({
        type: 'plan',
        tasks: check.plan.tasks.map((t) => ({ id: t.id, title: t.title, type: t.type, dependsOn: t.dependsOn })),
        warnings: [...new Set([...this.planNotes, ...check.warnings])],
        understanding: check.plan.understanding,
      });
      if (this.o.approvePlan) this.emit({ kind: 'phase', phase: 'approval' });
      if (this.o.approvePlan && !(await this.o.approvePlan(check.plan, [...new Set([...this.planNotes, ...check.warnings])]))) {
        throw new Error('План не утверждён — прогон остановлен.');
      }

      target = await git(this.o.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
      await this.ws.init();
      this.runBase = await this.ws.sha(this.ws.integration);
      this.understanding = check.plan.understanding;
      this.graph = new TaskGraph(check.plan.tasks);
      this.classifyPools('по плану');
    }
    this.target = target;
    this.runDir = runDir;
    this.runIdNow = runId;
    for (const id of this.o.humanFixes ?? []) this.submitHumanFix(id);
    for (const id of this.o.retryTasks ?? []) this.retryHuman(id);
    for (const [id, hint] of Object.entries(this.o.humanHints ?? {})) this.hintHuman(id, hint);
    for (const id of this.o.humanClose ?? []) this.closeByHuman(id);
    if (this.o.rework !== undefined) await this.planRework(this.o.rework);
    this.graph.onChange = () => {
      this.emitTasks();
      this.saveState();
    };
    this.saveState();
    this.emit({ kind: 'phase', phase: 'running' });
    this.emitTasks();

    await this.mainLoop();
    this.emit({ kind: 'phase', phase: 'verifying' });
    await this.finalVerify();
    this.emitTasks();

    // приёмка по цели: задачи зелёные, но получил ли человек то, что просил? Если нет — доделываем
    // продолжение, где ничего не влилось (ручная правка не прошла проверку) — приёмке смотреть не на что новое
    const goalRounds = this.o.resume && this.mergedHere === 0 ? 0 : ESCALATION.goalCheckRounds;
    for (let round = 1; round <= goalRounds && !this.stopRequested; round++) {
      if (!(await this.goalCheck(round))) break;
      this.emit({ kind: 'phase', phase: 'running' });
      await this.mainLoop();
      this.emit({ kind: 'phase', phase: 'verifying' });
      await this.finalVerify();
      this.emitTasks();
    }

    // человек сдал правку, пока шла приёмка, — доводим её и цепочку после неё
    // кнопки человека обрабатываются сразу (см. kickHuman) — после приёмки могла остаться готовая к работе задача
    while ((this.humanQueue.length || this.retryQueue.length || this.graph.hasActiveWork()) && !this.stopRequested) {
      this.emit({ kind: 'phase', phase: 'running' });
      await this.mainLoop();
      await this.finalVerify();
    }

    const done = this.graph.byStatus('done').map((t) => t.id);
    const human = this.graph.byStatus('human').map((t) => ({ id: t.id, why: this.humanReasons.get(t.id) ?? 'нужно решение человека' }));
    await this.cleanupWorktrees();

    // доставка: что изменилось и (по желанию) сразу в ветку пользователя
    const changes = await changedFiles(this.o.repo, { base: this.runBase, branch: this.ws.integration }).catch(() => [] as ChangedFile[]);
    // продолжение уже применённого прогона: помним, что было применено (новое доедет обычным применением поверх)
    const prevMeta = this.o.resume ? readMeta(this.o.repo, runId) : null;
    const issue = this.o.issue ?? prevMeta?.issue;
    writeMeta(this.o.repo, { runId, branch: this.ws.integration, base: this.runBase, target, done, human, ...(prevMeta?.applied ? { applied: prevMeta.applied } : {}), ...(issue ? { issue } : {}), ...(prevMeta?.published ? { published: prevMeta.published } : {}) });
    if (prevMeta?.applied && (await git(this.o.repo, ['rev-parse', 'HEAD'], true)) === prevMeta.applied.to && (await git(this.o.repo, ['rev-parse', this.ws.integration], true)) !== prevMeta.applied.to) {
      // применённое раньше — уже в проекте; чтобы новое тоже доехало, снимаем отметку (откат вернёт к состоянию до первого применения)
      const m = readMeta(this.o.repo, runId)!;
      const first = m.applied!.from;
      delete m.applied;
      writeMeta(this.o.repo, m);
      this.firstAppliedFrom = first;
    }
    let applied: ApplyResult | undefined;
    if (this.o.autoApply && changes.length) {
      // приёмка сказала «цель достигнута», а у человека только не начатые (их заменила доработка) — применению это не мешает
      const onlyNotStarted = human.every((h) => blockedReason(h.why));
      if (human.length === 0 || (this.lastGoal?.achieved === true && onlyNotStarted && done.length > 0)) {
        applied = await applyRun(this.o.repo, runId).catch((e: Error) => ({ ok: false, message: e.message }));
        // откат должен вернуть проект к состоянию до первого применения этого прогона, а не до второго
        if (applied.ok && this.firstAppliedFrom) {
          const m = readMeta(this.o.repo, runId);
          if (m?.applied) {
            m.applied.from = this.firstAppliedFrom;
            writeMeta(this.o.repo, m);
          }
        }
      }
      else applied = { ok: false, message: 'Не применено автоматически: часть задач ждёт человека. Посмотри изменения и примени вручную.' };
      this.journal.record({ type: 'applied', ok: applied.ok, message: applied.message, files: changes.length });
      // в применённом package.json появились пакеты — приводим в порядок lock-файл и node_modules проекта
      // package.json мог быть и в части проекта (web/package.json) — npm install в его папке
      const pkgDirs = applied.ok && this.installed_.size ? [...new Set(changes.filter((c) => /(^|\/)package\.json$/.test(c.file)).map((c) => path.posix.dirname(c.file)))] : [];
      for (const d of pkgDirs) {
        const r = await runCommand(process.env.AGENTYARD_NPM ? `node "${process.env.AGENTYARD_NPM}" install` : `npm install --no-audit --no-fund${this.legacyPeers ? ' --legacy-peer-deps' : ''}`, path.join(this.o.repo, d === '.' ? '' : d), 10 * 60_000);
        this.journal.record({ type: 'install', taskId: '—', packages: [...this.installed_.keys()], ok: r.code === 0, versions: Object.fromEntries(this.installed_), seconds: r.ms / 1000, output: r.code === 0 ? undefined : r.output.slice(-1500) });
      }
    }

    const seconds = (Date.now() - this.startedAt) / 1000;
    this.journal.record({ type: 'run-end', done: done.length, human: human.length, seconds, swaps: this.swaps });
    this.o.stats.save();
    const reportPath = this.journal.writeReport({
      goal: this.o.goal,
      branch: this.ws.integration,
      done,
      human,
      commands: this.commandsRun,
      changes,
      applied,
    });
    writeFileSync(path.join(runDir, 'tasks.json'), JSON.stringify(this.taskViews(), null, 2));
    this.clearActivity();
    this.emit({ kind: 'phase', phase: 'finished' });
    return { runDir, branch: this.ws.integration, done, human, reportPath, swaps: this.swaps, seconds, changes, applied, understanding: this.understanding, goal: this.lastGoal };
  }

  /**
   * Проверка цели целиком. true — добавлены задачи на доработку, нужно ещё поработать.
   * Для «fix-tests» не нужна: там цель и есть зелёные тесты.
   */
  private async goalCheck(round: number): Promise<boolean> {
    if (isFixTestsGoal(this.o.goal)) return false;
    // приёмку делает модель, которая уже в памяти (если она из бригады): лишняя смена модели — это 10–25 секунд
    const model = this.team.models.find((m) => m.ollamaTag === this.loadedTag && !this.brokenModels.has(m.id)) ?? this.team.byRole.reviewer;
    try {
      await this.ensureModel(model);
    } catch (e) {
      if (e instanceof ModelLoadError || e instanceof StopError) return false;
      throw e;
    }
    const diff = await git(this.o.repo, ['diff', '--no-color', `${this.runBase}..${this.ws.integration}`], true);
    const human = this.graph.byStatus('human').map((t) => ({ id: t.id, why: this.humanReasons.get(t.id) ?? '' }));
    const files: { file: string; text: string }[] = [];
    let budget = 8_000;
    for (const c of await changedFiles(this.o.repo, { base: this.runBase, branch: this.ws.integration }).catch(() => [] as ChangedFile[])) {
      if (c.status === 'deleted') continue;
      const text = await git(this.o.repo, ['show', `${this.ws.integration}:${c.file}`], true);
      if (!text || text.split('\n').length > 200 || text.length > budget) continue;
      budget -= text.length;
      files.push({ file: c.file, text });
    }
    const started = Date.now();
    let verdict: GoalVerdict;
    try {
      verdict = await checkGoal({
        runtime: this.o.runtime,
        modelTag: model.ollamaTag,
        thinking: model.thinking,
        goal: this.o.goal,
        understanding: this.understanding,
        diff: diff.length > 14_000 ? `${diff.slice(0, 14_000)}\n… (обрезано)` : diff,
        files,
        human,
        hints: [
          ...(await this.cssHints(this.runBase, this.ws.integration, this.o.repo)),
          ...(await this.colorHints(this.ws.integration, this.o.repo)),
          ...(await this.runFacts()),
          ...this.decisions.all().slice(-8).map((d) => `решение ${d.taskId}: ${d.facts.slice(0, 4).join('; ')}`),
        ],
        repoMapText: this.mapText,
        numCtx: this.o.numCtx,
        round,
        lowThink: this.gpuDeadAt > 0,
        onProgress: (p) => this.activity('gpu', { role: 'goalcheck', model: model.ollamaTag }, progressText('приёмка смотрит итог целиком', p), true),
      });
    } catch (e) {
      if (e instanceof StopError) return false;
      this.journal.record({ type: 'goal-check', round, model: model.ollamaTag, achieved: null, missing: [(e as Error).message.slice(0, 200)], added: [], seconds: (Date.now() - started) / 1000 });
      return false;
    }
    let added: string[] = [];
    if (verdict.achieved === false && verdict.tasks.length) {
      const ids = new Set(this.graph.all().map((t) => t.id));
      const follow = normalizeFollowUps(verdict.tasks, round, ids);
      const check = validatePlan({ goal: this.o.goal, tasks: follow }, this.o.repo, this.o.hardware.tier, this.map.commands);
      if (check.ok) added = this.graph.addPlanned(check.plan.tasks.map((t) => ({ ...t, stage: round > 1 ? `Доделки после проверки итога (${round})` : 'Доделки после проверки итога' }))).map((t) => t.id);
      if (added.length) this.classifyPools('доработка после приёмки');
    }
    this.journal.record({ type: 'goal-check', round, model: model.ollamaTag, achieved: verdict.achieved, missing: verdict.missing, added, seconds: (Date.now() - started) / 1000 });
    this.lastGoal = { achieved: verdict.achieved, missing: verdict.missing };
    return added.length > 0;
  }

  /** Состояние для продолжения после сбоя: пишется при каждом изменении статусов. */
  private saveState(): void {
    if (!this.runDir || !this.graph) return;
    const state: RunState = {
      runId: path.basename(this.runDir),
      goal: this.o.goal,
      understanding: this.understanding,
      base: this.runBase,
      target: this.target,
      tasks: this.graph.all().map((t) => ({ ...t, workdir: undefined, branch: undefined, createdHere: undefined })),
      humanReasons: [...this.humanReasons],
      installed: [...this.installed_],
      pools: [...this.pools.values()],
      solutions: [...this.solutions],
      decisions: this.decisions.toJSON(),
    };
    try {
      writeFileSync(path.join(this.runDir, 'state.json'), JSON.stringify(state));
    } catch {
      /* диск недоступен — продолжение просто не сработает */
    }
  }

  /** Рабочие копии задач и их ветки больше не нужны: результат уже в ветке сборки. */
  private async cleanupWorktrees(): Promise<void> {
    for (const t of this.graph.all()) {
      if (t.workdir) await this.ws.removeWorktree(t.workdir).catch(() => undefined);
      if (t.branch) await this.ws.deleteBranch(t.branch).catch(() => undefined);
    }
    if (this.baseDir) await this.ws.removeWorktree(await this.baseDir.catch(() => '')).catch(() => undefined);
    this.baseDir = null;
    await git(this.o.repo, ['worktree', 'prune'], true);
  }

  // ---------- проверки по частям проекта и сравнение с исходным состоянием ----------

  /** Команды проверки задачи: только части проекта, где лежат её файлы. */
  private commandsFor(t: Task, extra: string[] = []): ProjectCommands {
    return scopedCommands([...t.files, ...(t.newFiles ?? []), ...t.accept.tests, ...extra], this.map.stacks, this.map.commands);
  }

  /** Запуск тестов задачи раннером её части. */
  private testsFor(t: Task): string[] {
    return testCommandsFor(t.accept.tests, this.map.stacks, this.map.commands).commands;
  }

  /** Окружение каскада проверок для задачи: команды её части, тесты, старые ошибки, сравнение с исходным состоянием. */
  private checkEnv(t: Task, extra: string[] = []) {
    const plan = testCommandsFor(t.accept.tests, this.map.stacks, this.map.commands);
    return {
      commands: this.commandsFor(t, extra),
      testCommands: plan.commands,
      testsStrict: plan.specific,
      projectWide: (cmd: string) => isProjectWide(cmd, this.map.stacks, this.map.commands),
      moduleSystem: this.map.moduleSystem,
      knownErrors: this.knownErrors,
      compare: (cmd: string, r: CommandResult) => this.compareWithBase(cmd, r),
    };
  }

  /** Та же команда на исходном состоянии прогона (один раз на команду). */
  private async runOnBase(cmd: string): Promise<{ code: number; output: string }> {
    if (!this.runBase) return { code: 0, output: '' };
    this.baseDir ??= this.ws.detachedWorktree(this.runBase, 'base');
    const dir = await this.baseDir;
    const r = await runCommand(cmd, dir);
    return { code: r.code, output: r.output };
  }

  private async compareWithBase(cmd: string, r: CommandResult) {
    const base = await this.baseRunner.of(cmd);
    const cmp = compareOutcomes({ code: r.code, output: r.output }, base);
    if (cmp.preexisting && !this.notedBase.has(cmd)) {
      this.notedBase.add(cmd);
      this.journal.record({ type: 'self-help', taskId: '—', what: `«${cmd}» падает так же, как до прогона (${cmp.before} падений) — задачам это не засчитывается` });
    }
    return cmp;
  }

  /** После установки пакетов в части проекта: заново узнать её команды (появился tsc) и забыть старые запуски на исходном состоянии. */
  private refreshStacks(dir: string): void {
    const stacks = detectStacks(this.o.repo);
    const before = JSON.stringify(this.map.commands);
    this.map.stacks = stacks;
    this.map.commands = combinedCommands(stacks);
    this.ws.depDirs = dependencyDirs(stacks);
    this.baseRunner.invalidate((cmd) => !dir || cmd.includes(`cd "${dir}"`));
    if (JSON.stringify(this.map.commands) !== before) {
      this.journal.record({ type: 'self-help', taskId: '—', what: `после установки пакетов у части ${dir || 'корень'} появились проверки: ${[this.map.commands.typecheck, this.map.commands.lint].filter(Boolean).join('; ') || '—'}` });
    }
  }

  /**
   * Исходное состояние: если линтер или проверка типов падают ещё до работы агентов,
   * эта ступень завалила бы каждую задачу независимо от качества правки — отключаем её и говорим об этом.
   */
  private async baseline(): Promise<void> {
    const c = this.map.commands;
    for (const [key, name] of [['lint', 'линтер'], ['typecheck', 'проверка типов']] as const) {
      const cmd = c[key];
      if (!cmd) continue;
      const r = await runCommand(cmd, this.o.repo);
      this.commandsRun.push(cmd);
      if (r.code === 0) {
        this.journal.record({ type: 'baseline', stage: name, command: cmd, passed: true });
        continue;
      }
      const lines = errorLines(r.output);
      if (lines.length) {
        // ошибки, которые были до нас, запоминаем: задача падает только на новых
        this.knownErrors[key] = countErrorKeys(lines);
        this.journal.record({ type: 'baseline', stage: name, command: cmd, passed: false, known: lines.length, output: lines.slice(0, 10).join('\n') });
      } else {
        c[key] = null;
        this.journal.record({ type: 'baseline', stage: name, command: cmd, passed: false, output: r.output.slice(0, 1500) });
      }
    }
    if (!c.test && !c.testFiles) this.journal.record({ type: 'baseline', stage: 'тесты', command: '', passed: false, output: 'в проекте нет запуска тестов' });
  }

  private async makePlan(): Promise<Plan> {
    if (this.o.planFile) {
      const raw = JSON.parse(readFileSync(this.o.planFile, 'utf8')) as Plan | Plan['tasks'];
      return Array.isArray(raw) ? { goal: this.o.goal, tasks: raw } : raw;
    }
    if (isFixTestsGoal(this.o.goal)) return planFixTests(this.o.repo, this.map);
    // планировщик не загрузился — пробуем остальные модели бригады, а не роняем прогон сразу
    // модель уже в памяти планирует почти так же хорошо — планирует она: смена модели (7–20 с) ради плана не окупается
    const loadedM = this.team.models.find((m) => m.ollamaTag === this.loadedTag);
    const best = this.team.byRole.planner;
    const first = loadedM && (loadedM.roles.planner ?? 0) >= (best.roles.planner ?? 0) - 0.1 ? loadedM : best;
    const candidates = [first, ...this.team.models.filter((m) => m.id !== first.id)];
    let planner = candidates[0]!;
    for (const [i, candidate] of candidates.entries()) {
      try {
        await this.ensureModel(candidate);
        planner = candidate;
        break;
      } catch (e) {
        if (!(e instanceof ModelLoadError) || i === candidates.length - 1) throw e;
      }
    }
    const q = goalTerms(this.o.goal);
    const hits = searchRepo(this.o.repo, this.map.files, q);
    const contextText = renderHits(hits, q);
    if (hits.length) this.journal.record({ type: 'context', files: hits.map((h) => h.file) });
    const recipes = pickRecipes(this.o.goal, this.map.tags ?? this.map.dependencies ?? []);
    if (recipes.length) this.journal.record({ type: 'recipe', names: recipes.map((r) => r.name) });
    // копилка решений: подводные камни библиотек проекта и цели (то, на чём уже падали)
    const goalWords = (this.o.goal.toLowerCase().match(/[a-z@][\w@/.-]{2,}/g) ?? []);
    const known = this.book.byTags([...Object.keys(this.projectDeps()).map((n) => (n.startsWith('@') ? n.slice(1).split('/')[0]! : n)), ...goalWords, ...(this.map.tags ?? [])]);
    if (known.length) this.journal.record({ type: 'learned-hit', taskId: '—', titles: known.map((k) => k.title), sections: known.map((k) => k.section) });
    const res = await planWithModel({
      runtime: this.o.runtime,
      modelTag: planner.ollamaTag,
      thinking: planner.thinking,
      goal: this.o.goal,
      repo: this.o.repo,
      repoMapText: this.mapText,
      tier: this.o.hardware.tier,
      numCtx: this.o.numCtx,
      commands: this.map.commands,
      contextText,
      recipesText: [...recipes.map((r) => r.text), ...(known.length ? [`Известные подводные камни (копилка решений — на этом уже падали, учти в шагах):\n${SolutionBook.render(known)}`] : [])].join('\n\n'),
      lowThink: this.gpuDeadAt > 0,
      onProgress: (p) => this.activity('gpu', { role: 'planner', model: planner.ollamaTag }, progressText('составляет план', p), true),
    });
    this.activity('gpu', {}, null);
    if (!res.ok) throw new Error(`Планировщик не смог составить корректный план:\n${res.errors.join('\n')}`);
    // поправки первой проверки (шаблоны → образец, установка → в следующую задачу) — второй проверке их уже не видно
    this.planNotes.push(...res.warnings);
    // просьба про внешний вид, поиск нашёл общий CSS, а план его не трогает — даём кодеру этот файл тоже:
    // маленькие модели часто красят одну страницу инлайн-стилем вместо общего класса
    const css = hits.find((h) => /\.(css|scss|sass|less)$/i.test(h.file))?.file;
    // план ставит библиотеку (UI-кит) — он про компоненты, а не про правку стилей: общий CSS не подкладываем (его стирали)
    if (q.visual && css && !res.plan.tasks.some((t) => t.files.includes(css) || t.install?.length)) {
      // в задачу «по образцу» не добавляем: там первый файл — образец для всех однотипных
      const first = res.plan.tasks.find((t) => t.type === 'edit' && !t.similar && t.files.length > 0);
      if (first && first.files.length < this.limits.maxFiles + 1) {
        first.files = [...first.files, css];
        this.planNotes.push(`${first.id}: добавил общий файл стилей ${css} — просьба про внешний вид.`);
      }
    }
    return res.plan;
  }

  // ---------- главный цикл ----------

  private async mainLoop(): Promise<void> {
    await this.mainLoopInner();
    this.retireBlocked();
  }

  /**
   * Задачи, которые ждут проваленных: сами они уже не начнутся — честно отдаём человеку с причиной (и приёмка их видит).
   * Составная задача, у которой часть у человека, тоже не соберётся.
   */
  private retireBlocked(): void {
    for (let changed = true; changed; ) {
      changed = false;
      for (const t of this.graph.all()) {
        if (t.status !== 'waiting') continue;
        const stuck = t.dependsOn.filter((d) => this.graph.tasks.get(d)?.status === 'human');
        if (stuck.length) {
          this.toHuman(t, `не начата: зависит от ${stuck.join(', ')}, которая ждёт человека`);
          changed = true;
          continue;
        }
        const parts = (t.children ?? []).map((c) => this.graph.tasks.get(c)).filter((c): c is Task => !!c);
        const stuckParts = parts.filter((c) => c.status === 'human');
        if (stuckParts.length && parts.every((c) => c.status === 'done' || c.status === 'human')) {
          this.toHuman(t, `не собрана: часть ${stuckParts.map((c) => c.id).join(', ')} ждёт человека`);
          changed = true;
        }
      }
    }
  }

  /** Человек сдал ручную правку задачи (кнопкой или сохранением файла). Обработается в главном цикле. */
  submitHumanFix(taskId: string): void {
    if (!this.humanQueue.includes(taskId)) this.humanQueue.push(taskId);
    this.kickHuman();
  }

  /** Человек нажал «Менять нечего — закрыть»: задача закрывается без правки. */
  closeByHuman(taskId: string): void {
    this.closeQueue.add(taskId);
    this.submitHumanFix(taskId);
  }
  private closeQueue = new Set<string>();

  /**
   * Кнопки человека не ждут, пока видеокарта закончит текущий шаг (планировщик может думать минуты):
   * проверка ручной правки и «разбить без меня» идут сразу на процессорной дорожке.
   */
  private kickHuman(): void {
    if (!this.graph || !this.runDir) return;
    this.cpu.run(async () => {
      if (this.retryQueue.length) this.drainRetries();
      if (this.humanQueue.length) await this.drainHumanFixes();
    });
  }

  /** Сданные, но ещё не обработанные ручные правки (прогон уже заканчивался) — их доведёт продолжение. */
  pendingHumanFixes(): string[] {
    return [...this.humanQueue];
  }

  pendingCloses(): string[] {
    return [...this.closeQueue];
  }

  private retryQueue: string[] = [];
  /** Человек нажал «Разбить и попробовать без меня». Обработается в главном цикле. */
  retryHuman(taskId: string): void {
    if (!this.retryQueue.includes(taskId)) this.retryQueue.push(taskId);
    this.kickHuman();
  }
  pendingRetries(): string[] {
    return [...this.retryQueue];
  }

  /**
   * Человек посмотрел «на чём споткнулись» и вставил решение. Задача снова у агентов — не дробится, попытки с нуля,
   * подсказка идёт исполнителю в каждой следующей попытке (и аналитику, и при дроблении).
   */
  hintHuman(taskId: string, hint: string): void {
    let t = this.graph?.tasks.get(taskId);
    // составная задача ждёт свою застрявшую часть — подсказка нужна той части
    if (t?.children?.length) {
      const parts = (x: Task): Task[] => (x.children ?? []).map((c) => this.graph.tasks.get(c)).filter((c): c is Task => !!c).flatMap((c) => [c, ...parts(c)]);
      const stuck = parts(t).filter((d) => d.status === 'human' && !d.children?.length && !blockedReason(this.humanReasons.get(d.id)));
      if (stuck.length === 1) t = stuck[0];
    }
    // «\u0000» — подсказка уже записана в задаче (продолжение прогона, который закончился раньше, чем она ушла в работу)
    const text = hint === '\u0000' ? '' : hint.trim().slice(0, 8000);
    if (!t || (!text && !t.humanHint)) return;
    if (text) t.humanHint = t.humanHint ? `${t.humanHint}\n\n${text}` : text;
    // задача ещё у агентов — подсказка просто пойдёт со следующей попыткой
    if (t.status !== 'human') {
      this.journal.record({ type: 'self-help', taskId: t.id, what: `человек подсказал: «${firstLine(text).slice(0, 160)}» — пойдёт исполнителю со следующей попыткой` });
      this.graph.onChange?.();
      return;
    }
    this.hintQueue.add(t.id);
    if (!this.retryQueue.includes(t.id)) this.retryQueue.push(t.id);
    this.kickHuman();
  }
  private hintQueue = new Set<string>();
  /** Подсказки, которые не успели уйти в работу (прогон закончился): id → текст. */
  pendingHints(): Record<string, string> {
    // текст уже в задаче; продолжение добавит его ещё раз — поэтому передаём пустую строку-признак, а не текст
    return Object.fromEntries([...this.hintQueue].map((id) => [id, '\u0000']));
  }

  /**
   * Задача снова у агентов. Не встали пакеты — просто повтор (установка теперь умеет свежие версии и --legacy-peer-deps).
   * Иначе — планировщик разбивает её на подзадачи (можно другим путём), и они идут обычным порядком.
   */
  private drainRetries(): void {
    while (this.retryQueue.length) {
      const id = this.retryQueue.shift()!;
      const t = this.graph.all().find((x) => x.id === id);
      if (!t || t.status !== 'human') continue;
      const why = this.humanReasons.get(id) ?? '';
      this.humanReasons.delete(id);
      t.attempts = 0;
      t.failures = [];
      if (this.hintQueue.delete(id)) {
        // человек подсказал решение: тот же исполнитель, с подсказкой, без дробления и лестницы с начала
        t.attemptLog = [];
        t.ladderStep = 2;
        t.needsSplit = false;
        t.needsAnalysis = false;
        t.forceModel = undefined;
        this.journal.record({ type: 'self-help', taskId: id, what: `человек подсказал решение — задача снова у исполнителя с подсказкой: «${firstLine(t.humanHint ?? '').slice(0, 160)}»` });
      } else if (/поставить пакеты/.test(why)) {
        this.journal.record({ type: 'self-help', taskId: id, what: 'человек попросил попробовать ещё раз — ставлю пакеты заново (свежие версии, при конфликте — --legacy-peer-deps)' });
      } else if (this.graph.depth(t.id) >= ESCALATION.maxSplitDepth + 2) {
        // уже очень мелкая часть: дробить дальше некуда — ещё раз целиком, со справкой по ошибке
        t.needsLookup = true;
        this.journal.record({ type: 'self-help', taskId: id, what: 'человек попросил попробовать ещё раз: часть уже очень мелкая — не дроблю, а пробую заново со справкой по ошибке' });
      } else {
        t.needsSplit = true;
        t.rethink = true;
        t.splitByHuman = true;
        this.journal.record({ type: 'self-help', taskId: id, what: 'человек попросил разбить задачу на подзадачи и попробовать без него' });
      }
      this.graph.setStatus(id, 'ready');
      this.reviveBlocked();
    }
  }

  /** Ручные правки: те же проверки, что у агента (кроме границ задачи — человеку можно больше), слияние, цепочка дальше. */
  private async drainHumanFixes(): Promise<void> {
    while (this.humanQueue.length) {
      const id = this.humanQueue.shift()!;
      const t = this.graph.all().find((x) => x.id === id);
      if (!t || t.status !== 'human') continue;
      const dir = humanDir(this.o.repo, this.runIdNow, id);
      const branch = humanBranch(this.runIdNow, id);
      const keep = (why: string, output?: string) => {
        this.humanReasons.set(id, why);
        if (output) t.lastError = output;
        this.graph.setStatus(id, 'human');
        this.journal.record({ type: 'human-fix', taskId: id, ok: false, why });
      };
      const closing = this.closeQueue.delete(id);
      let changed = existsSync(dir) ? await handoffChanges(dir) : [];
      if (closing && !changed.length) {
        // человек посмотрел и решил: менять нечего (проверочная задача, правка уже есть, «проверка» задачи бессмысленна)
        this.closeDone(t, 'человек: менять нечего');
        await dropHandoff(this.o.repo, this.runIdNow, id);
        continue;
      }
      if (!changed.length) {
        // правки нет — может, она и не нужна: проверки задачи на текущем коде
        // закрываем сами, только если есть чем проверить (или это проверочная задача); иначе — кнопка «Менять нечего»
        const checkable = isVerifyTask(t) || !!t.doneWhen?.length || t.accept.tests.length > 0 || t.accept.commands.some((c) => isCheckCommand(c, this.map.commands));
        const problem = checkable ? await this.verifyUnchanged(t, existsSync(dir) ? dir : null) : 'проверить программой нечем';
        if (problem === null) {
          this.closeDone(t, 'человек не стал править: проверки задачи на текущем коде проходят — менять нечего');
          if (existsSync(dir)) await dropHandoff(this.o.repo, this.runIdNow, id);
          continue;
        }
        keep(checkable ? `файлы не изменены, а проверка задачи на текущем коде не проходит (${firstLine(problem)}). Поправь файл и сохрани — или нажми «Менять нечего — закрыть», если задача не нужна.` : 'файлы в ручной рабочей копии не изменены — сохрани правку или нажми «Менять нечего — закрыть», если менять и правда нечего', checkable ? problem : undefined);
        continue;
      }
      const cascade = (files: string[]) =>
        runCascade({
          task: { ...t, frozenFiles: [] },
          workdir: dir,
          changedFiles: files,
          changedLines: 0,
          maxChangedLines: Number.MAX_SAFE_INTEGER,
          ...this.checkEnv(t, files),
          onStage: (x) => this.activity(`cpu:${id}`, { taskId: id }, `проверяет твою правку: ${x}`),
        });
      this.graph.setStatus(id, 'checking');
      const check = await cascade(changed);
      this.journal.record({ type: 'checks', taskId: id, passed: check.passed, stage: check.stage, stageName: check.stageName, seconds: check.durationMs / 1000, output: check.passed ? undefined : check.output.slice(0, 2000) });
      if (!check.passed) {
        keep(`ручная правка не прошла проверку (${check.stageName}): ${firstLine(check.output)}. Исправь и сохрани ещё раз.`, check.output);
        continue;
      }
      await this.ws.commitAll(dir, `${t.id}: ${t.title}\n\nСделано вручную человеком в AgentYard.`);
      const ok = await this.merge.lock(async () => {
        const prev = await this.ws.sha(this.ws.integration);
        const conflict = await this.ws.rebaseOntoIntegration(dir);
        if (conflict) {
          await git(dir, ['reset', '-q', '--soft', 'HEAD~1'], true);
          return `конфликт с тем, что агенты влили после открытия файла: ${firstLine(conflict)}`;
        }
        await this.ws.fastForwardIntegration(branch);
        t.doneBy = 'человек';
        // решение человека — такое же решение, как у агента: в журнал решений и в повтор по образцу
        await this.afterMerge(t, prev, 'человек');
        return null;
      });
      if (ok) {
        keep(`${ok}. Закрой файл, нажми «Начать заново» на карточке и повтори правку.`);
        continue;
      }
      this.activity(`cpu:${id}`, {}, null);
      t.doneBy = 'человек';
      this.humanReasons.delete(id);
      this.graph.setStatus(id, 'done');
      this.mergedHere += 1;
      this.journal.record({ type: 'human-fix', taskId: id, ok: true, why: `проверки пройдены, файлы: ${changed.join(', ')}` });
      this.journal.record({ type: 'merged', taskId: id, commit: await this.ws.sha(this.ws.integration) });
      await dropHandoff(this.o.repo, this.runIdNow, id);
      this.reviveBlocked();
    }
  }

  /** Задачи, не начатые из-за проваленной: блокер сделан — возвращаем их в работу агентам. */
  private reviveBlocked(): void {
    for (let changed = true; changed; ) {
      changed = false;
      for (const t of this.graph.all()) {
        if (t.status !== 'human' || !blockedReason(this.humanReasons.get(t.id))) continue;
        if (t.dependsOn.some((d) => this.graph.tasks.get(d)?.status === 'human')) continue;
        if ((t.children ?? []).some((c) => this.graph.tasks.get(c)?.status === 'human')) continue;
        this.humanReasons.delete(t.id);
        t.status = 'waiting';
        this.journal.record({ type: 'revived', taskId: t.id });
        changed = true;
      }
    }
    this.graph.refreshReady();
    this.graph.onChange?.();
  }

  private async mainLoopInner(): Promise<void> {
    for (;;) {
      if (this.humanQueue.length) await this.drainHumanFixes();
      if (this.retryQueue.length) this.drainRetries();
      // сборка матрёшки снизу вверх: собралась часть — может собраться и её родитель
      for (let i = 0; i < 8 && this.graph.assemblable().length; i++) await this.merge.lock(() => this.assembleComposites());
      if (this.stopRequested) {
        await this.cpu.waitAll();
        for (const t of this.graph.all()) {
          if (['waiting', 'ready', 'review'].includes(t.status)) this.toHuman(t, started(t) ? 'прогон остановлен человеком — задача не доделана; «Продолжить прогон» продолжит с этого места' : 'прогон остановлен человеком до начала этой задачи');
        }
        break;
      }
      const items = this.workItems();
      if (items.length === 0) {
        if (this.cpu.size() > 0) {
          await this.cpu.waitAny();
          continue;
        }
        break;
      }
      const pick = this.pickNext(items);
      if (pick === 'wait') {
        await this.cpu.waitAny();
        continue;
      }
      if (!pick) {
        const broken = [...this.brokenModels.entries()];
        const why = broken.length
          ? `Ollama не смогла загрузить ${broken.map(([id]) => id).join(', ')} (${broken[0]![1].slice(0, 160)}). Перезапусти Ollama (значок в трее → Quit, затем снова открыть) и запусти прогон ещё раз.`
          : 'ни одна модель бригады не помещается в память для этой задачи';
        for (const it of items) this.toHuman(it.task, why);
        continue;
      }
      await this.execute(pick);
    }
    await this.cpu.waitAll();
  }

  /** Что сейчас может делать видеокарта. */
  private workItems(): WorkItem[] {
    const out: WorkItem[] = [];
    for (const t of this.graph.all()) {
      if (this.tiraging.has(t.id)) continue;
      if (t.status === 'ready') {
        const role: Role = t.needsSplit ? 'planner' : t.needsAnalysis ? 'analyst' : t.role;
        out.push({ task: t, role, kind: 'work' });
      } else if (t.status === 'review') {
        out.push({ task: t, role: 'reviewer', kind: 'review' });
      }
    }
    return out;
  }

  /**
   * Строгий конвейер (conveyor.ts): начатое доделывается раньше нового, не больше WIP задач в работе,
   * стадии задачи подряд, ревью со сменой модели — пачкой. 'wait' — всё начатое на проверках, ждём процессор.
   */
  private pickNext(items: WorkItem[]): DispatchPick | 'wait' | null {
    const ctx = this.dispatchCtx();
    const all = this.graph.all();
    const r = conveyorPick(items, all, ctx, {
      blocks: (t) => all.filter((x) => x.status === 'waiting' && x.dependsOn.includes(t.id)).length,
      forced: (t) => (t.forceModel ? (this.installed.find((m) => m.id === t.forceModel) ?? null) : null),
      isLeader: (t) => !!t.pool && this.pools.get(t.pool)?.leader === t.id,
      checking: this.cpu.size() > 0,
    });
    if (r.pick) return r.pick;
    if (r.wait && this.cpu.size() > 0) return 'wait';
    // в работе полно, а проверять нечего — так быть не должно; не стоим, берём по общей оценке
    return chooseNext(items, ctx);
  }

  private dispatchCtx() {
    return {
      team: this.team,
      stats: this.o.stats,
      loadedModelId: this.installed.find((m) => m.ollamaTag === this.loadedTag)?.id ?? null,
      now: Date.now(),
      fits: (m: CatalogModel) => !this.brokenModels.has(m.id) && canRun(m, this.o.hardware, this.o.numCtx, this.o.allowOffload),
      shaky: this.gpuShaky,
    };
  }

  /** Выгрузить из видеопамяти всё, кроме нужной модели (в том числе модели других программ и прошлых прогонов). */
  private async freeGpu(keep: string | null): Promise<void> {
    const resident = await this.o.runtime.loaded().catch(() => [] as string[]);
    for (const tag of resident) if (tag !== keep) await this.o.runtime.unload(tag).catch(() => undefined);
  }

  /**
   * Загрузка модели с защитой от сбоев CUDA (Windows: 0xc0000409, «shared object initialization failed»):
   * 1) перед загрузкой видеопамять освобождается от всех моделей и ждём фактической выгрузки;
   * 2) при сбое — пауза, повторная очистка и повтор (Ollama перезапускает упавший процесс);
   * 3) если видеокарта так и не отвечает — та же модель на процессоре: медленно, но прогон не встаёт.
   */
  private async ensureModel(model: CatalogModel): Promise<void> {
    if (this.loadedTag === model.ollamaTag) return;
    const from = this.loadedTag;
    await this.freeGpu(null);
    this.loadedTag = null;
    let ms = 0;
    const gpuAttemptsDefault = this.loadRetries.length + 1;
    const cpuForced = this.gpuDeadAt > 0 && Date.now() - this.gpuDeadAt < 4 * 60_000;
    // видеокарта давно «умерла» — одна попытка на ней, без долгих повторов, потом снова процессор
    const gpuAttemptsNow = this.gpuDeadAt > 0 && !cpuForced ? 1 : null;
    for (let attempt = 1; ; attempt++) {
      const cpuOnly = cpuForced || attempt > (gpuAttemptsNow ?? gpuAttemptsDefault);
      this.activity('gpu', { model: model.ollamaTag }, cpuOnly ? `загружает модель ${model.ollamaTag} в оперативную память (видеокарта сбоит — работа на процессоре, медленнее)` : `загружает модель ${model.ollamaTag} в видеокарту${attempt > 1 ? ` (попытка ${attempt})` : ''}`);
      try {
        ms = await this.o.runtime.load(model.ollamaTag, this.o.numCtx, { cpuOnly });
        if (cpuOnly && !cpuForced) {
          this.gpuDeadAt = Date.now();
          this.journal.record({ type: 'gpu-fallback', model: model.ollamaTag });
        } else if (!cpuOnly && this.gpuDeadAt) {
          this.gpuDeadAt = 0;
          this.journal.record({ type: 'gpu-back', model: model.ollamaTag });
        }
        break;
      } catch (e) {
        if (e instanceof StopError || this.stopRequested) throw new StopError();
        const error = (e as Error).message.slice(0, 400);
        const final = cpuOnly;
        if (!cpuOnly && !this.gpuShaky) {
          this.gpuShaky = true;
          this.journal.record({ type: 'self-help', taskId: '—', what: 'видеокарта сбоит при загрузке моделей — дальше держусь одной загруженной модели: меньше смен — меньше сбоев (ревью делает та же модель)' });
        }
        this.journal.record({ type: 'model-failed', model: model.ollamaTag, error, attempt, final });
        if (final) {
          this.brokenModels.set(model.id, error);
          throw new ModelLoadError(model.ollamaTag, error);
        }
        // два сбоя подряд — перезапускаем Ollama целиком (не чаще раза в 10 минут): сбой CUDA живёт в её процессе
        if (attempt === 2 && this.o.runtime.restart && Date.now() - this.lastOllamaRestart > 10 * 60_000) {
          this.lastOllamaRestart = Date.now();
          this.activity('gpu', { model: model.ollamaTag }, 'видеокарта сбоит — перезапускаю Ollama');
          const ok = await this.o.runtime.restart().catch(() => false);
          this.journal.record({ type: 'self-help', taskId: '—', what: ok ? 'видеокарта дважды не загрузила модель — перезапустил Ollama и пробую снова' : 'перезапустить Ollama не получилось — пробую дальше как есть' });
          if (ok) continue;
        }
        // Ollama сама перезапускает упавший процесс модели — даём ей время и снова чистим память
        const pause = this.loadRetries[attempt - 1];
        if (pause) await new Promise((r) => setTimeout(r, pause));
        await this.freeGpu(null);
      }
    }
    this.o.stats.recordSpeed(model.id, { swapSec: ms / 1000 });
    this.loadedTag = model.ollamaTag;
    this.swaps += 1;
    this.batchStartPending = true;
    this.journal.record({ type: 'swap', from, to: model.ollamaTag, ms });
  }

  private async execute(pick: DispatchPick): Promise<void> {
    const { item, model } = pick;
    this.journal.record({ type: 'dispatch', taskId: item.task.id, role: item.role, model: model.ollamaTag, reason: pick.reason });
    this.active = { taskId: item.task.id, role: item.role, model: model.ollamaTag };
    this.emitTasks();
    // «Стоп» посреди шага: задача возвращается к состоянию до шага, попытка не засчитывается
    const snap = structuredClone(item.task);
    const reason = this.humanReasons.get(item.task.id);
    const cut = this.cutCalls;
    try {
      try {
        await this.ensureModel(model);
      } catch (e) {
        // модель не загрузилась: задача остаётся в своём статусе, диспетчер выберет другую модель
        if (e instanceof ModelLoadError) return;
        throw e;
      }
      if (item.kind === 'review') return await this.doReview(item.task, model);
      if (item.task.needsLookup) await this.lookup(item.task);
      if (item.role === 'analyst') return await this.doAnalysis(item.task, model);
      if (item.role === 'planner') return await this.doSplit(item.task, model);
      return await this.doWork(item.task, model);
    } catch (e) {
      if (!(e instanceof StopError)) throw e;
    } finally {
      if (this.cutCalls > cut) this.rollbackStopped(item.task, snap, reason);
      this.active = null;
      this.activity('gpu', {}, null);
      this.emitTasks();
    }
  }

  /** Запрос задачи оборвал «Стоп»: всё, что шаг успел поменять в задаче (попытки, ступень, статус), — назад. */
  private rollbackStopped(t: Task, snap: Task, reason: string | undefined): void {
    const keepWorkdir = t.workdir;
    Object.assign(t, snap);
    // рабочая копия могла появиться за этот шаг — она остаётся (её удалит уборка в конце)
    if (!t.workdir && keepWorkdir) t.workdir = keepWorkdir;
    if (reason === undefined) this.humanReasons.delete(t.id);
    else this.humanReasons.set(t.id, reason);
    this.journal.record({ type: 'self-help', taskId: t.id, what: 'прогон остановлен человеком посреди шага — запрос к модели оборван, задача возвращена к состоянию до шага (попытка не засчитана)' });
    this.graph.onChange?.();
  }

  // ---------- работа над задачей ----------

  private async ensureWorktree(t: Task): Promise<void> {
    if (t.workdir && existsSync(t.workdir)) return;
    const { dir, branch } = await this.ws.createTaskWorktree(t.id);
    t.workdir = dir;
    t.branch = branch;
    this.baseSha.set(t.id, await this.ws.sha(this.ws.integration));
    // что задача создаст сама — то она может и переписывать целиком
    t.createdHere = [...t.files, ...t.accept.tests].filter((f) => !existsSync(path.join(dir, f)));
  }

  private agentInput(t: Task, role: Role, model: CatalogModel, diff?: string, extra?: Partial<TaskContext>) {
    return {
      context: { ...this.taskContext(t, role), ...extra },
      task: t,
      role,
      modelTag: model.ollamaTag,
      thinking: model.thinking,
      workdir: t.workdir!,
      repoMapText: this.mapText,
      maxSteps: this.limits.maxSteps,
      numCtx: this.o.numCtx,
      diff,
      goal: isFixTestsGoal(this.o.goal) ? undefined : this.o.goal,
      // прогресс генерации приходит раз в секунду — это то же действие, таймер не сбрасываем
      onActivity: (text: string) => this.activity('gpu', { taskId: t.id, role, model: model.ollamaTag }, text, /ток\.|читает задачу/.test(text)),
    };
  }

  /** Прямой режим, если всё нужное известно; иначе — цикл с инструментами. */
  private async runRole(t: Task, role: Role, model: CatalogModel, diff?: string, extra?: Partial<TaskContext>, temperature?: number): Promise<AgentResult> {
    const input = { ...this.agentInput(t, role, model, diff, extra), ...(temperature !== undefined ? { temperature } : {}) };
    try {
      return await (canGoDirect(role, t, t.workdir!) ? runDirect(this.o.runtime, input) : runAgent(this.o.runtime, input));
    } catch (e) {
      // «Стоп» человека — не неудача попытки
      if (e instanceof StopError || this.abort.signal.aborted) throw new StopError();
      // сбой рантайма (таймаут, Ollama упала) — это неудача попытки, а не крах всего прогона
      return { ok: false, error: (e as Error).message, changedFiles: [], changedLines: 0, steps: 0, promptTokens: 0, outputTokens: 0, promptMs: 0, genMs: 0, log: [], transcript: [], shimmed: 0 };
    }
  }

  private transcriptN = 0;
  /** Полная переписка агента — в папку прогона, для разбора неудач. */
  private saveTranscript(t: Task, role: Role, model: CatalogModel, r: AgentResult): void {
    this.transcriptN += 1;
    const dir = path.join(this.journal.dir, 'transcripts');
    mkdirSync(dir, { recursive: true });
    const name = `${String(this.transcriptN).padStart(3, '0')}-${t.id}-${role}-${r.ok ? 'ok' : 'fail'}.json`;
    writeFileSync(
      path.join(dir, name),
      JSON.stringify({ task: t.id, role, model: model.ollamaTag, ok: r.ok, error: r.error, shimmed: r.shimmed, log: r.log, messages: r.transcript }, null, 2),
    );
  }

  private learn(model: CatalogModel, role: Role, r: AgentResult, t?: Task): void {
    if (t) this.saveTranscript(t, role, model, r);
    if (r.genMs > 0) this.o.stats.recordSpeed(model.id, { genTokPerSec: r.outputTokens / (r.genMs / 1000) });
    if (r.promptMs > 0) this.o.stats.recordSpeed(model.id, { prefillTokPerSec: r.promptTokens / (r.promptMs / 1000) });
    if (r.steps > 0) {
      this.o.stats.recordShape(role, { steps: r.steps, outTokens: r.outputTokens / r.steps, promptTokens: r.promptTokens / r.steps });
    }
  }

  private async doWork(t: Task, model: CatalogModel): Promise<void> {
    this.graph.setStatus(t.id, 'running');
    await this.ensureWorktree(t);
    t.lastModel = model.id;
    t.doneBy = model.id;
    // самодельные «проверки» (grep, test…) из старых планов: в Windows их нет, а на отсутствие они падают всегда
    const badCmds = t.accept.commands.filter((c) => !isCheckCommand(c, this.map.commands) || isRedundantCheck(c, this.map.commands));
    if (badCmds.length) {
      t.accept.commands = t.accept.commands.filter((c) => isCheckCommand(c, this.map.commands) && !isRedundantCheck(c, this.map.commands));
      this.journal.record({ type: 'self-help', taskId: t.id, what: `убрал из критерия команды, которые ничего не проверяют, не работают в Windows или дублируют проверку типов (она идёт отдельной ступенью с учётом старых ошибок проекта): ${badCmds.join('; ')}` });
    }
    // задача над большим документом: целиком в запрос он не влезет — программа режет его на части (карта → свёртка)
    if (t.inputs?.length && t.attempts === 0 && (await this.chunkInputs(t))) return;

    // задача «проверить / убедиться»: сначала проверяет программа — если всё уже так, модель не нужна
    if (isVerifyTask(t) && t.attempts === 0 && (await this.verifyUnchanged(t, t.workdir!)) === null) {
      this.closeDone(t, 'проверочная задача: на текущем коде всё уже так — менять нечего');
      return;
    }

    // пакеты, которые нужны задаче: ставим один раз, в package.json рабочей копии дописываем на каждой попытке
    if (t.install?.length && !(await this.ensurePackages(t))) return;

    // задача только «поставить пакеты»: всё сделала программа (node_modules + package.json рабочей копии) — модель не нужна
    if (t.install?.length && t.role === 'coder' && t.files.length === 0 && !t.newFiles?.length) {
      const pj = `${nodeDirFor([...t.files, ...(t.newFiles ?? [])], this.map.stacks) || ''}/package.json`.replace(/^\//, '');
      this.journal.record({ type: 'agent-done', taskId: t.id, role: t.role, model: '—', ok: true, steps: 0, files: [pj], note: `пакеты ${t.install.join(', ')} поставлены программой`, seconds: 0 });
      const r: AgentResult = { ok: true, patches: [], changedFiles: [pj], changedLines: 0, note: 'пакеты поставлены программой', steps: 0, promptTokens: 0, outputTokens: 0, promptMs: 0, genMs: 0, log: [], transcript: [], shimmed: 0 };
      this.graph.setStatus(t.id, 'checking');
      this.cpu.run(async () => {
        const check = await runCascade({ task: t, workdir: t.workdir!, changedFiles: r.changedFiles, changedLines: 0, maxChangedLines: this.limits.maxChangedLines, ...this.checkEnv(t, r.changedFiles), onStage: this.stageReporter(t) });
        this.activity(`cpu:${t.id}`, {}, null);
        this.journal.record({ type: 'checks', taskId: t.id, passed: check.passed, stage: check.stage, stageName: check.stageName, seconds: check.durationMs / 1000, output: check.passed ? undefined : check.output.slice(0, 2000) });
        await this.afterChecks(t, r, check);
      });
      return;
    }

    const started = Date.now();
    const r = await this.runRole(t, t.role, model);
    this.learn(model, t.role, r, t);
    this.journal.record({
      type: 'agent-done',
      taskId: t.id,
      role: t.role,
      model: model.ollamaTag,
      ok: r.ok,
      steps: r.steps,
      files: r.changedFiles,
      note: r.note,
      error: r.error,
      seconds: (Date.now() - started) / 1000,
    });

    if (!r.ok) {
      await this.ws.reset(t.workdir!);
      // «менять нечего» дважды подряд: возможно, всё уже сделано — проверяем программой, а не гоняем лестницу до человека
      if (/ничего не меняют|Список patches пуст/.test(r.error ?? '')) {
        t.noops = (t.noops ?? 0) + 1;
        if (t.noops >= 2 && (await this.verifyUnchanged(t, t.workdir!)) === null) {
          this.closeDone(t, 'исполнитель дважды ответил, что менять нечего, и проверки задачи на текущем коде проходят — задача закрыта, итог проверит приёмка по цели');
          return;
        }
      } else t.noops = 0;
      this.fail(t, r.formatFailure ? 'format' : `agent:${r.error ?? ''}`, r.error ?? 'агент не сдал работу', r.formatFailure ? 1 : undefined);
      return;
    }
    t.noops = 0;
    t.lastNote = r.note;
    t.lastChanged = r.changedFiles;
    if (r.addedFiles?.length) this.journal.record({ type: 'self-help', taskId: t.id, what: `правке понадобились ещё файлы (${r.addedFiles.join(', ')}) — разрешил и добавил их в задачу` });

    // правка импортирует пакет, которого нет в зависимостях её части (Mantine в web/), — ставит программа:
    // иначе нечем проверить типы, а у человека не соберётся. Модель тут ни при чём — попытка не тратится
    const missing = this.missingImports(t, r.changedFiles);
    if (missing.length && this.o.allowInstall) {
      t.install = [...new Set([...(t.install ?? []), ...missing])];
      this.journal.record({ type: 'self-help', taskId: t.id, what: `правка импортирует ${missing.join(', ')}, а в зависимостях её части их нет — ставлю пакеты сам` });
      if (!(await this.ensurePackages(t))) return;
      const nodeDir = nodeDirFor([...t.files, ...(t.newFiles ?? [])], this.map.stacks) ?? '';
      r.changedFiles = [...new Set([...r.changedFiles, nodeDir ? `${nodeDir}/package.json` : 'package.json'])];
    }

    // повтор после своей ошибки: ещё варианты той же модели (без смены), программа возьмёт прошедший проверки
    if (this.shouldSample(t)) {
      const list = await this.moreCandidates(t, model, r);
      if (list.length > 1) {
        this.graph.setStatus(t.id, 'checking');
        this.cpu.run(() => this.checkCandidates(t, list));
        return;
      }
      await this.applyDiff(t.workdir!, list[0]!.diff);
    }

    // проверки — на процессорной дорожке, видеокарта тем временем берёт следующую задачу
    this.graph.setStatus(t.id, 'checking');
    this.cpu.run(async () => {
      const check = await runCascade({
        task: t,
        workdir: t.workdir!,
        changedFiles: r.changedFiles,
        changedLines: r.changedLines,
        maxChangedLines: this.limits.maxChangedLines,
        ...this.checkEnv(t, r.changedFiles),
        onStage: this.stageReporter(t),
      });
      this.activity(`cpu:${t.id}`, {}, null);
      this.noteCommands(t);
      this.journal.record({
        type: 'checks',
        taskId: t.id,
        passed: check.passed,
        stage: check.stage,
        stageName: check.stageName,
        seconds: check.durationMs / 1000,
        output: check.passed ? undefined : check.output.slice(0, 2000),
      });
      await this.afterChecks(t, r, check);
    });
  }

  // ---------- варианты правки ----------

  private shouldSample(t: Task): boolean {
    const n = this.o.sampling ?? (this.o.runtime.name === 'mock' ? 1 : SAMPLING.candidates);
    const last = t.attemptLog?.at(-1);
    return n > 1 && t.role === 'coder' && t.attempts >= 1 && !!last && ['own', 'collateral'].includes(last.cls) && !this.stopRequested;
  }

  /** Правка в рабочей копии как diff (с новыми файлами). */
  private async snapshot(dir: string): Promise<string> {
    await git(dir, ['add', '-A']);
    return git(dir, ['diff', '--cached', '--binary', 'HEAD'], true);
  }

  private async applyDiff(dir: string, diff: string): Promise<void> {
    if (!diff.trim()) return;
    const file = path.join(this.journal.dir, `candidate-${Date.now().toString(36)}.diff`);
    writeFileSync(file, diff.endsWith('\n') ? diff : `${diff}\n`);
    await git(dir, ['apply', '--whitespace=nowarn', '--index', file], true);
  }

  /** Ещё варианты той же модели с другой температурой. Первый — уже сделанный ответ. */
  private async moreCandidates(t: Task, model: CatalogModel, first: AgentResult): Promise<{ r: AgentResult; diff: string }[]> {
    const dir = t.workdir!;
    const n = this.o.sampling ?? SAMPLING.candidates;
    const list = [{ r: first, diff: await this.snapshot(dir) }];
    await this.ws.reset(dir);
    for (let k = 1; k < n && !this.stopRequested; k++) {
      const started = Date.now();
      const temperature = SAMPLING.temperatures[k] ?? 0.7;
      const r = await this.runRole(t, t.role, model, undefined, undefined, temperature);
      this.learn(model, t.role, r, t);
      this.journal.record({ type: 'agent-done', taskId: t.id, role: t.role, model: model.ollamaTag, ok: r.ok, steps: r.steps, files: r.changedFiles, note: `вариант ${k + 1} из ${n}${r.note ? `: ${r.note}` : ''}`, error: r.error, seconds: (Date.now() - started) / 1000 });
      if (r.ok && r.changedFiles.length) {
        const diff = await this.snapshot(dir);
        if (diff.trim() && !list.some((x) => x.diff === diff)) list.push({ r, diff });
      }
      await this.ws.reset(dir);
    }
    return list;
  }

  /** Проверить варианты по очереди: первый прошедший — в работу; не прошёл ни один — тот, что упал позже всех и с меньшим числом ошибок. */
  private async checkCandidates(t: Task, list: { r: AgentResult; diff: string }[]): Promise<void> {
    const dir = t.workdir!;
    const rank = (c: CheckResult) => c.stage * 1000 - Math.min(999, c.output.split('\n').filter((l) => /error|FAIL|not ok|нет `|осталось/i.test(l)).length);
    let best: { r: AgentResult; check: CheckResult; i: number } | null = null;
    for (const [i, c] of list.entries()) {
      await this.ws.reset(dir);
      await this.applyDiff(dir, c.diff);
      const check = await runCascade({ task: t, workdir: dir, changedFiles: c.r.changedFiles, changedLines: c.r.changedLines, maxChangedLines: this.limits.maxChangedLines, ...this.checkEnv(t, c.r.changedFiles), onStage: this.stageReporter(t) });
      this.journal.record({ type: 'checks', taskId: t.id, passed: check.passed, stage: check.stage, stageName: `${check.stageName}, вариант ${i + 1} из ${list.length}`, seconds: check.durationMs / 1000, output: check.passed ? undefined : check.output.slice(0, 1200) });
      if (check.passed) {
        this.journal.record({ type: 'self-help', taskId: t.id, what: `из ${list.length} вариантов правки проверки прошёл ${i + 1}-й — беру его` });
        this.activity(`cpu:${t.id}`, {}, null);
        this.noteCommands(t);
        t.lastChanged = c.r.changedFiles;
        await this.afterChecks(t, c.r, check);
        return;
      }
      if (!best || rank(check) > rank(best.check)) best = { r: c.r, check, i };
    }
    this.activity(`cpu:${t.id}`, {}, null);
    this.journal.record({ type: 'self-help', taskId: t.id, what: `ни один из ${list.length} вариантов не прошёл проверки — дальше по лестнице с ошибкой лучшего (${best!.i + 1}-го)` });
    t.lastChanged = best!.r.changedFiles;
    await this.afterChecks(t, best!.r, best!.check);
  }

  /** Правки CSS, которые на экране не проявятся (перебиты более точным правилом). from/to — коммиты; cwd — где спрашивать git. */
  private async cssHints(from: string, to: string, cwd: string): Promise<string[]> {
    const files = (await git(cwd, ['diff', '--name-only', `${from}..${to}`], true)).split('\n').filter((f) => /\.(css|scss|less)$/i.test(f));
    const out: string[] = [];
    for (const f of files.slice(0, 5)) {
      const before = await git(cwd, ['show', `${from}:${f}`], true);
      const after = await git(cwd, ['show', `${to}:${f}`], true);
      if (after) out.push(...cssOverrideWarnings(before, after).map((w) => `${f}: ${w}`));
    }
    return out;
  }

  /** Цвета элементов, о которых просит цель, в изменённых CSS (и в главном CSS, если правили не его). */
  private async colorHints(ref: string, cwd: string): Promise<string[]> {
    const changed = (await git(cwd, ['diff', '--name-only', `${this.runBase}..${ref}`], true)).split('\n').filter((f) => /\.(css|scss|less)$/i.test(f));
    const files = changed.length ? changed : this.map.files.filter((f) => /\.(css|scss|less)$/i.test(f)).slice(0, 2);
    const out: string[] = [];
    for (const f of files.slice(0, 3)) {
      const text = await git(cwd, ['show', `${ref}:${f}`], true);
      if (text) out.push(...colorFacts(this.o.goal, text).map((x) => `${f}: ${x}`));
    }
    return out;
  }

  /** Пакеты, которые импортируют изменённые файлы, а в package.json их части их нет. */
  private missingImports(t: Task, files: string[]): string[] {
    const nodeDir = nodeDirFor(files, this.map.stacks);
    if (nodeDir === null || !t.workdir) return [];
    const pj = path.join(t.workdir, nodeDir, 'package.json');
    if (!existsSync(pj)) return [];
    let deps = new Set<string>();
    try {
      const pkg = JSON.parse(readFileSync(pj, 'utf8')) as Record<string, Record<string, string> | undefined>;
      deps = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}), ...this.installed_.keys()]);
    } catch {
      return [];
    }
    const out = new Set<string>();
    for (const f of files) {
      if (!/\.(m|c)?[jt]sx?$|\.vue$|\.svelte$/.test(f) || (nodeDir && !f.startsWith(`${nodeDir}/`))) continue;
      try {
        for (const p of missingPackages(readFileSync(path.join(t.workdir, f), 'utf8'), deps)) out.add(p);
      } catch {
        /* файла нет */
      }
    }
    return [...out];
  }

  /** Поставить пакеты задачи. false — задача ушла к человеку (нет разрешения или npm не смог). */
  private async ensurePackages(t: Task): Promise<boolean> {
    // проект из частей: пакеты — в папку node-части файлов задачи (web/), а не в корень, где нет package.json
    const nodeDir = nodeDirFor([...t.files, ...(t.newFiles ?? [])], this.map.stacks) ?? '';
    const need = t.install!.filter((spec) => !this.installed_.has(pkgName(spec)));
    if (need.length) {
      if (!this.o.allowInstall) {
        this.toHuman(t, `нужно поставить пакеты npm: ${need.join(', ')}. Разреши установку пакетов в настройках прогона или поставь сам: npm install ${need.join(' ')}`);
        return false;
      }
      const started = Date.now();
      this.activity('gpu', { taskId: t.id }, `ставит пакеты npm${nodeDir ? ` в ${nodeDir}/` : ''}: ${need.join(', ')}`);
      const res = await installPackages(path.join(this.o.repo, nodeDir), need);
      this.journal.record({ type: 'install', taskId: t.id, packages: need, ok: res.ok, versions: res.versions, seconds: (Date.now() - started) / 1000, output: res.ok ? undefined : res.output.slice(-1500), note: res.note });
      if (res.ok && /legacy-peer-deps/.test(res.note ?? '')) this.legacyPeers = true;
      // пакеты встали только обходным путём — в копилку: в следующий раз сразу ясно, почему и что делать
      if (res.ok && res.note) {
        const names = need.map(pkgName);
        const why = /ERESOLVE|peer/i.test(res.output) ? 'ERESOLVE: peer-зависимости пакета не совпадают с проектом' : 'указанные версии пакетов не ставятся';
        const sol = this.book.add({
          id: solutionId(`${why} ${names.join(' ')}`, [/ERESOLVE/i.test(res.output) ? 'eresolve' : 'npm', ...names]),
          section: 'packages',
          title: `${names.join(', ')}: ${why}`,
          tags: [...new Set([/ERESOLVE/i.test(res.output) ? 'eresolve' : 'npm', 'npm', ...names.map((n) => (n.startsWith('@') ? n.slice(1).split('/')[0]! : n)), ...names])],
          error: why,
          fix: [res.note, `версии: ${Object.entries(res.versions).map(([n, v]) => `${n}@${v}`).join(', ')}`],
          where: `${path.basename(this.o.repo)}: ${t.id}`,
        });
        this.journal.record({ type: 'learned', taskId: t.id, section: 'packages', title: sol.solution.title, fresh: sol.fresh, file: sol.file ? 'skills/learned/packages.md' : null });
      }
      if (!res.ok) {
        const lines = res.output.split('\n');
        const why = lines.find((l) => /ERR!|E404|404/.test(l)) ?? lines.find((l) => /error/i.test(l)) ?? lines[0] ?? '';
        this.toHuman(t, `не получилось поставить пакеты ${need.join(', ')}: ${why.trim().slice(0, 300)}`);
        return false;
      }
      for (const [n, v] of Object.entries(res.versions)) this.installed_.set(n, v);
      // у части могли появиться проверки (tsc из node_modules) — узнаём заново; запуски на исходном состоянии устарели
      this.refreshStacks(nodeDir);
      if (this.baseDir) this.ws.linkDependencies(await this.baseDir);
    }
    // node_modules мог появиться только сейчас — даём ссылку и рабочей копии
    this.ws.linkDependencies(t.workdir!);
    const versions = Object.fromEntries(t.install!.map((spec) => [pkgName(spec), this.installed_.get(pkgName(spec)) ?? '*']));
    addDependencies(path.join(t.workdir!, nodeDir), versions);
    // поставилось только с --legacy-peer-deps — то же нужно и npm install в Docker и у человека: пишем это в .npmrc проекта
    if (this.legacyPeers) {
      const npmrc = path.join(t.workdir!, nodeDir, '.npmrc');
      const text = existsSync(npmrc) ? readFileSync(npmrc, 'utf8') : '';
      if (!/legacy-peer-deps\s*=\s*true/.test(text)) writeFileSync(npmrc, `${text}${text && !text.endsWith('\n') ? '\n' : ''}legacy-peer-deps=true\n`);
      const rel = nodeDir ? `${nodeDir}/.npmrc` : '.npmrc';
      if (!t.files.includes(rel)) t.files.push(rel);
    }
    return true;
  }

  private noteCommands(t: Task): void {
    const c = this.commandsFor(t);
    if (c.lint) this.commandsRun.push(c.lint);
    if (c.typecheck) this.commandsRun.push(c.typecheck);
    this.commandsRun.push(...this.testsFor(t), ...t.accept.commands);
  }

  private async afterChecks(t: Task, r: AgentResult, check: CheckResult): Promise<void> {
    if (!check.passed) {
      t.lastPatchHash = createHash('sha1').update(JSON.stringify((r.patches ?? []).map((p) => [p.file, (p.search ?? '').trim(), p.replace.trim()]))).digest('hex').slice(0, 12);
      await this.ws.reset(t.workdir!);
      t.lastPatch = r.patches;
      this.fail(t, check.signature, `Ступень ${check.stage} (${check.stageName}):\n${check.output}`);
      return;
    }
    await this.ws.commitAll(t.workdir!, `${t.id}: ${t.title}\n\nРоль: ${t.role}, модель: ${t.doneBy}. ${r.note ?? ''}`.trim());
    // мелкая правка без ревью — только если программа не видит в ней подвоха (перебитый CSS и т.п.)
    const trivial = this.trivialChange(t, r) && (await this.cssHints(this.ws.integration, 'HEAD', t.workdir!)).length === 0;
    // повтор принятого решения пула: решение уже прошло ревью на образце, признаки готовности проверила программа
    const solved = !!t.solutionFrom && !!t.doneWhen?.length && this.decisions.get(t.solutionFrom) !== undefined;
    if (this.o.review && !trivial && !solved) {
      this.graph.setStatus(t.id, 'review');
    } else {
      if (this.o.review) {
        const why = solved
          ? `повтор решения, принятого на ${t.solutionFrom}: ревью было на образце, признаки готовности и проверки пройдены — смена модели не нужна`
          : 'мелкая правка оформления или настроек — отдельное ревью не нужно, итог проверит приёмка по цели';
        this.journal.record({ type: 'review', taskId: t.id, model: '—', verdict: 'skipped', reasons: [why] });
      }
      await this.integrate(t);
    }
  }

  /**
   * Мелкая правка стилей, разметки, текстов или настроек (Dockerfile, .json, .yml) без логики — ревью не стоит смены модели:
   * в конце весь результат и так смотрит приёмка по цели. Тесты и код с логикой ревьюятся всегда.
   */
  private trivialChange(t: Task, r: AgentResult): boolean {
    if (isFixTestsGoal(this.o.goal) || t.type === 'test' || t.similar) return false;
    const lines = (r.patches ?? []).reduce((n, p) => n + Math.max(p.search ? p.search.split('\n').length : 0, p.replace.split('\n').length), 0);
    if (lines > 15 || r.changedFiles.length === 0) return false;
    return r.changedFiles.every((f) => ASSET_RE.test(f) || /(^|\/)(Dockerfile[^/]*|Containerfile|\.dockerignore|\.env\.example|\.nvmrc)$|\.(ya?ml|toml|ini)$/i.test(f));
  }

  private async doReview(t: Task, model: CatalogModel): Promise<void> {
    let diff = await this.ws.diffAgainstIntegration(t.workdir!, t.similar ? [t.files[0]!] : []);
    const hints = [...(await this.cssHints(this.ws.integration, 'HEAD', t.workdir!))];
    if (hints.length) diff += `\n\n## Проверено программой по коду\n${hints.map((h) => `- ${h}`).join('\n')}\nЕсли из-за этого цель задачи не достигнута — верни задачу с этой причиной.`;
    if (t.similar) {
      const n = matchFiles(t.similar, listFiles(t.workdir!)).filter((f) => f !== t.files[0]).length;
      diff += `\n\n(Показан только образец. После слияния программа повторит эту правку ещё в ${n} однотипных файлах по шаблону ${t.similar}; файлы, где повтор не встанет, получат свои задачи.)`;
    }
    const changed = (await git(t.workdir!, ['diff', '--name-only', `${this.ws.integration}...HEAD`], true)).split('\n').filter(Boolean);
    const shown = t.similar ? changed.filter((f) => f === t.files[0]) : changed;
    const files = shown
      .filter((f) => existsSync(path.join(t.workdir!, f)) && !/\.(json|lock|md)$/i.test(f))
      .map((f) => ({ file: f, text: readFileSync(path.join(t.workdir!, f), 'utf8') }))
      .filter((x) => x.text.split('\n').length <= 250)
      .slice(0, 2);
    const c = this.commandsFor(t);
    const verified = [
      `проверки программы пройдены: синтаксис${c.lint ? ', линтер' : ''}${c.typecheck ? ', проверка типов (значит, все используемые имена импортированы и объявлены)' : ''}${this.testsFor(t).length || t.accept.commands.length ? ', тесты и команды задачи' : ''}`,
      ...(t.doneWhen?.length ? ['признаки готовности выполнены: старого в файлах не осталось, нужное появилось'] : []),
    ];
    const started = Date.now();
    this.graph.setStatus(t.id, 'running');
    const r = await this.runRole(t, 'reviewer', model, diff, { verified, files });
    this.learn(model, 'reviewer', r, t);
    this.journal.record({ type: 'agent-done', taskId: t.id, role: 'reviewer', model: model.ollamaTag, ok: r.ok, steps: r.steps, files: [], error: r.error, seconds: (Date.now() - started) / 1000 });
    t.firstOfBatch = false;

    if (!r.ok || !r.review) {
      // ревьюер не справился с формой — все программные проверки уже зелёные, поэтому принимаем с пометкой
      this.journal.record({ type: 'review', taskId: t.id, model: model.ollamaTag, verdict: 'skipped', reasons: [r.error ?? 'ревьюер не сдал ответ'] });
      this.graph.setStatus(t.id, 'checking');
      this.cpu.run(() => this.integrate(t));
      return;
    }
    // причины ревью, которые программа может опровергнуть фактами (импорт есть, «другие страницы» — не эта задача), снимаем
    let verdict = r.review.verdict;
    let reasons = r.review.reasons;
    if (verdict === 'changes') {
      const vet = this.vetReview(t, reasons, changed);
      if (vet.dropped.length) {
        reasons = vet.kept;
        if (!reasons.length) verdict = 'approve';
        this.journal.record({ type: 'review-vetted', taskId: t.id, dropped: vet.dropped, approved: verdict === 'approve' });
      }
    }
    this.journal.record({ type: 'review', taskId: t.id, model: model.ollamaTag, verdict, reasons, coverage: r.review.coverage });
    if (verdict === 'approve') {
      this.graph.setStatus(t.id, 'checking');
      this.cpu.run(() => this.integrate(t));
    } else {
      t.lastPatch = undefined;
      this.fail(t, `review:${normalize(reasons.join('|'))}`, `Ревью вернуло задачу. Твои изменения сохранены — доработай их.\nПричины:\n- ${reasons.join('\n- ')}`);
    }
  }

  /**
   * Проверка причин ревью фактами. Маленькие ревьюеры часто пишут «нет импорта X», глядя только на diff,
   * и «другие страницы не изменены», когда задача — одна часть большой работы. Такие причины программа снимает.
   */
  vetReview(t: Task, reasons: string[], changed: string[]): { kept: string[]; dropped: { reason: string; why: string }[] } {
    const texts = changed
      .map((f) => {
        try {
          return { file: f, text: readFileSync(path.join(t.workdir!, f), 'utf8') };
        } catch {
          return null;
        }
      })
      .filter((x): x is { file: string; text: string } => !!x);
    const typed = !!this.commandsFor(t).typecheck;
    const part = !!(t.pool || t.parent || t.similar);
    const kept: string[] = [];
    const dropped: { reason: string; why: string }[] = [];
    for (const reason of reasons) {
      const why = importClaimFalse(reason, texts, typed) ?? (part ? scopeClaimFalse(reason, t) : null);
      if (why) dropped.push({ reason, why });
      else kept.push(reason);
    }
    return { kept, dropped };
  }

  private async doAnalysis(t: Task, model: CatalogModel): Promise<void> {
    this.graph.setStatus(t.id, 'running');
    await this.ensureWorktree(t);
    const started = Date.now();
    const r = await this.runRole(t, 'analyst', model);
    this.learn(model, 'analyst', r, t);
    this.journal.record({ type: 'agent-done', taskId: t.id, role: 'analyst', model: model.ollamaTag, ok: r.ok, steps: r.steps, files: r.brief?.files ?? [], note: r.brief?.brief.slice(0, 200), error: r.error, seconds: (Date.now() - started) / 1000 });
    t.needsAnalysis = false;
    if (r.ok && r.brief) {
      t.brief = `${t.brief}\n\nУточнение аналитика: ${r.brief.brief}`;
      const extra = r.brief.files.filter((f) => existsSync(path.join(t.workdir!, f)) && !t.frozenFiles.includes(f));
      t.files = [...new Set([...t.files, ...extra])].slice(0, this.limits.maxFiles + 1);
    }
    this.graph.setStatus(t.id, 'ready');
  }

  /**
   * Большие исходные материалы: «карта — свёртка». Текст режется по абзацам на куски, которые помещаются в запрос;
   * каждая часть — своя задача («выпиши из этой части всё нужное для итога»), последняя собирает итог из выжимок.
   * Итог тоже большой — он сам снова разрежется (матрёшка). true — задача разбита.
   */
  private async chunkInputs(t: Task): Promise<boolean> {
    const budget = inputBudget(this.o.numCtx);
    const dir = t.workdir && existsSync(t.workdir) ? t.workdir : this.o.repo;
    const texts = (t.inputs ?? []).map((f) => {
      const abs = path.isAbsolute(f) ? f : path.join(dir, f);
      const ex = existsSync(abs) ? extractText(abs) : null;
      return { f, text: ex?.text ?? '' };
    });
    const total = texts.reduce((n, x) => n + x.text.length, 0);
    if (total <= budget || this.graph.depth(t.id) >= 4) return false;
    const all = texts.map((x) => `# ${path.basename(x.f)}\n${x.text}`).join('\n\n');
    const chunks = chunkText(all, Math.floor(budget * 0.8)).slice(0, 60);
    const store = path.join(this.journal.dir, 'chunks');
    mkdirSync(store, { recursive: true });
    const slug = t.id.replace(/[^\w.-]/g, '_');
    const parts: PlannedTask[] = chunks.map((text, i) => {
      const n = i + 1;
      const src = path.join(store, `${slug}-${String(n).padStart(2, '0')}.txt`);
      writeFileSync(src, text);
      const out = `out/.parts/${slug}-${String(n).padStart(2, '0')}.md`;
      return {
        id: `${t.id}.${n}`,
        type: 'edit',
        title: `Часть ${n} из ${chunks.length}: выжимка`,
        brief: `Это часть ${n} из ${chunks.length} исходных материалов задачи «${t.title}». Выпиши из неё всё, что понадобится для итога: ${t.brief}\nФакты, цифры, имена, даты, определения — дословно и коротко, по пунктам. Ничего не добавляй от себя. Запиши в ${out}.`,
        dependsOn: [],
        files: [out],
        newFiles: [out],
        inputs: [src],
        accept: { tests: [], commands: [] },
        size: 'S',
      };
    });
    const outs = parts.map((p) => p.files[0]!);
    parts.push({
      id: `${t.id}.${chunks.length + 1}`,
      type: 'edit',
      title: `Собрать итог: ${t.title}`,
      brief: `${t.brief}\nИсходные материалы — выжимки частей документа по порядку (${outs.length} шт.). Собери из них итог целиком, без повторов.`,
      dependsOn: parts.map((p) => p.id),
      files: [...t.files],
      newFiles: [...(t.newFiles ?? [])],
      inputs: outs,
      accept: { tests: [], commands: [] },
      size: 'M',
      ...(t.steps?.length ? { steps: t.steps } : {}),
    });
    if (t.workdir) await this.ws.removeWorktree(t.workdir);
    if (t.branch) await this.ws.deleteBranch(t.branch);
    t.workdir = undefined;
    t.branch = undefined;
    this.baseSha.set(`${t.id}#split`, await this.ws.sha(this.ws.integration));
    const created = this.graph.split(t.id, parts);
    this.journal.record({ type: 'self-help', taskId: t.id, what: `исходные материалы большие (${Math.round(total / 1000)} тыс. знаков при запросе на ${Math.round(budget / 1000)} тыс.) — режу на ${chunks.length} частей: каждая — выжимка, последняя собирает итог` });
    this.journal.record({ type: 'split', taskId: t.id, into: created.map((c) => c.id), rethink: false });
    return true;
  }

  private async doSplit(t: Task, model: CatalogModel): Promise<void> {
    this.graph.setStatus(t.id, 'running');
    t.needsSplit = false;
    const rethink = !!t.rethink;
    const byHuman = !!t.splitByHuman;
    t.rethink = false;
    t.splitByHuman = false;
    const parts = await splitWithModel({
      rethink,
      byHuman,
      // дробление маленькой задачи не требует долгих рассуждений: планировщик думал по 2–4 минуты на разбиение
      lowThink: true,
      onProgress: (p) => this.activity('gpu', { taskId: t.id, role: 'planner', model: model.ollamaTag }, progressText(rethink ? 'ищет другой подход' : 'дробит задачу', p), true),
      runtime: this.o.runtime,
      modelTag: model.ollamaTag,
      thinking: model.thinking,
      task: t,
      repo: this.o.repo,
      repoMapText: this.mapText,
      tier: this.o.hardware.tier,
      numCtx: this.o.numCtx,
      commands: this.map.commands,
      decisionsText: DecisionLog.render(this.decisions.relevant(t, this.graph.tasks), 1800) || undefined,
    }).catch(() => null);
    if (!parts) {
      if (rethink) {
        this.toHuman(t, byHuman ? `разбить на подзадачи не получилось: планировщик не дал годного плана. Последняя ошибка: ${firstLine(t.lastError ?? '')}` : `обычные способы и другой подход не помогли. Последняя ошибка: ${firstLine(t.lastError ?? '')}`);
        return;
      }
      // дробление не получилось — следующая ступень
      t.ladderStep = 4;
      this.escalateTo(t, 5);
      return;
    }
    if (t.workdir) await this.ws.removeWorktree(t.workdir);
    if (t.branch) await this.ws.deleteBranch(t.branch);
    // пакеты родителя нужны подзадачам: ставим их перед первой (программа ставит один раз)
    const withInstall = parts.map((p, i) => (i === 0 && t.install?.length ? { ...p, install: [...new Set([...(p.install ?? []), ...t.install])] } : p));
    // матрёшка: задача остаётся составной и соберётся из частей; где была ветка сборки в момент дробления — для повтора её решения
    this.baseSha.set(`${t.id}#split`, await this.ws.sha(this.ws.integration));
    // части наследуют пул задачи-образца: когда соберётся — её решение повторится в остальных
    const created = this.graph.split(t.id, withInstall.map((p) => ({ ...p, freeze: [...(p.freeze ?? []), ...t.frozenFiles] })));
    this.journal.record({ type: 'split', taskId: t.id, into: created.map((c) => c.id), rethink });
    this.classifyPools('после дробления');
  }

  // ---------- слияние ----------

  private integrate(t: Task): Promise<void> {
    return this.merge.lock(async () => {
      this.activity(`cpu:${t.id}`, { taskId: t.id }, 'вливает правку в ветку сборки');
      const headNow = await this.ws.sha(this.ws.integration);
      const conflict = await this.ws.rebaseOntoIntegration(t.workdir!);
      if (conflict) {
        this.journal.record({ type: 'conflict', taskId: t.id });
        await this.ws.removeWorktree(t.workdir!);
        await this.ws.deleteBranch(t.branch!);
        t.workdir = undefined;
        t.branch = undefined;
        this.fail(t, 'conflict', `Конфликт при слиянии с веткой сборки:\n${conflict}`);
        return;
      }
      // ветка сборки ушла вперёд — повторяем проверки на новой основе
      if (this.baseSha.get(t.id) !== headNow) {
        const changed = (await git(t.workdir!, ['diff', '--name-only', `${headNow}..HEAD`])).split('\n').filter(Boolean);
        const recheck = await runCascade({
          task: t,
          workdir: t.workdir!,
          changedFiles: changed,
          changedLines: 0,
          maxChangedLines: Number.MAX_SAFE_INTEGER,
          ...this.checkEnv(t, changed),
        });
        if (!recheck.passed) {
          this.journal.record({ type: 'checks', taskId: t.id, passed: false, stage: recheck.stage, stageName: `${recheck.stageName} после переноса`, seconds: recheck.durationMs / 1000 });
          this.fail(t, recheck.signature, `После переноса на свежую ветку сборки проверки упали:\n${recheck.output}`);
          return;
        }
      }
      await this.ws.fastForwardIntegration(t.branch!);
      const commit = await this.ws.sha(this.ws.integration);
      if (t.attempts === 0 && t.lastModel) this.o.stats.recordOutcome(t.lastModel, t.role, t.size, true);
      this.activity(`cpu:${t.id}`, {}, null);
      this.mergedHere += 1;
      this.journal.record({ type: 'merged', taskId: t.id, commit });
      await this.ws.removeWorktree(t.workdir!);
      await this.ws.deleteBranch(t.branch!);
      t.workdir = undefined;
      // решения задачи — в журнал решений; образец пула — повтор в остальных файлах (всё под замком слияния)
      await this.afterMerge(t, headNow, t.doneBy);
    });
  }

  /**
   * После слияния задачи: факты её решения — в журнал (вниз, вбок, вверх по матрёшке),
   * «как починили» — тем, кто падает на той же ошибке; образец — повторяется программой в однотипных файлах.
   * Статус «сделана» ставится здесь, после повтора: задачи пула видят готовое решение.
   */
  private async afterMerge(t: Task, prev: string, by?: string): Promise<void> {
    const head = await this.ws.sha(this.ws.integration);
    const files = (await git(this.o.repo, ['diff', '--name-only', `${prev}..${head}`], true)).split('\n').filter(Boolean);
    const changes: FileChange[] = [];
    for (const f of files.slice(0, 12)) {
      const existedBefore = (await git(this.o.repo, ['ls-tree', '--name-only', prev, '--', f], true)) !== '';
      const existsNow = (await git(this.o.repo, ['ls-tree', '--name-only', head, '--', f], true)) !== '';
      changes.push({
        file: f,
        before: existedBefore ? await git(this.o.repo, ['show', `${prev}:${f}`], true) : null,
        after: existsNow ? await git(this.o.repo, ['show', `${head}:${f}`], true) : null,
      });
    }
    const installed = (t.install ?? []).map((x) => `${pkgName(x)}@${this.installed_.get(pkgName(x)) ?? '*'}`);
    const facts = extractFacts(changes, { installed });
    this.decisions.add({ taskId: t.id, title: t.title, facts, files, by, pool: t.pool, parent: t.parent });
    if (facts.length) this.journal.record({ type: 'decision', taskId: t.id, facts });
    // справилась с ошибкой, на которой падала, — рецепт для других с той же ошибкой
    const lastSig = t.failures.at(-1);
    if (lastSig && !lastSig.startsWith('review:')) this.decisions.addFix({ signature: lastSig, taskId: t.id, facts });
    // падала на проверке, а теперь прошла — как именно, в копилку решений (между прогонами и проектами)
    if (t.lastCheckError && t.lastCheckSig) await this.recordSolution(t, prev, head, changes, facts, by);
    // сначала повтор, потом «сделана»: задачи пула, ждущие образец, не должны уйти к модели раньше программы
    // часть составной задачи — повтор не по её кусочку решения, а по решению целиком при сборке родителя
    if (t.similar && !t.parent) await this.tirageSimilar(t, prev);
    if (t.pool && !t.parent) await this.tiragePool(t, prev);
    this.graph.setStatus(t.id, 'done');
  }

  // ---------- доработка по просьбе человека ----------

  /**
   * Доработка законченного прогона: чего не хватает по последней приёмке + что написал человек →
   * планировщик даёт задачи (с учётом уже принятых решений), они идут обычным конвейером в той же ветке.
   */
  private async planRework(note: string): Promise<void> {
    const prevMissing = this.lastMissingFromJournal();
    const round = 1 + new Set(this.graph.all().map((t) => /^R(\d+)\./.exec(t.id)?.[1]).filter(Boolean)).size;
    const decisions = DecisionLog.render(this.decisions.all().slice(-10), 2000);
    const goal = [
      this.o.goal,
      '',
      `ДОРАБОТКА (раунд ${round}). Основная работа уже сделана и влита — не переделывай её.`,
      ...(decisions ? ['Уже принятые решения:', decisions] : []),
      ...(note ? [`Человек просит доделать (это главное): ${note}`] : []),
      ...(prevMissing.length ? [`Приёмка считает, что не хватает (проверь по коду — приёмка видела урезанный diff и могла ошибиться; делай только то, чего правда нет):`, ...prevMissing.map((m) => `- ${m}`)] : []),
    ].join('\n');
    if (!note && !prevMissing.length) {
      this.journal.record({ type: 'rework', round, note, missing: [], added: [] });
      return;
    }
    const model = this.team.models.find((m) => m.ollamaTag === this.loadedTag && !this.brokenModels.has(m.id)) ?? this.team.byRole.planner;
    try {
      await this.ensureModel(model);
    } catch (e) {
      if (e instanceof ModelLoadError || e instanceof StopError) return;
      throw e;
    }
    this.emit({ kind: 'phase', phase: 'planning' });
    const q = goalTerms(`${note} ${prevMissing.join(' ')}`);
    const hits = searchRepo(this.o.repo, this.map.files, q);
    const res = await planWithModel({
      runtime: this.o.runtime,
      modelTag: model.ollamaTag,
      thinking: model.thinking,
      goal,
      repo: this.o.repo,
      repoMapText: this.mapText,
      tier: this.o.hardware.tier,
      numCtx: this.o.numCtx,
      commands: this.map.commands,
      contextText: renderHits(hits, q),
      lowThink: true,
      onProgress: (p) => this.activity('gpu', { role: 'planner', model: model.ollamaTag }, progressText('планирует доработку', p), true),
    }).catch(() => null);
    this.activity('gpu', {}, null);
    let added: string[] = [];
    if (res?.ok) {
      const ids = new Set(this.graph.all().map((t) => t.id));
      const rename = new Map(res.plan.tasks.map((t, i) => [t.id, `R${round}.${i + 1}`]));
      const tasks = res.plan.tasks.map((t) => ({
        ...t,
        id: ids.has(rename.get(t.id)!) ? `${rename.get(t.id)!}b` : rename.get(t.id)!,
        dependsOn: t.dependsOn.map((d) => rename.get(d)).filter((d): d is string => !!d),
        stage: note ? `Доработка: ${note.split('\n')[0]!.slice(0, 60)}` : `Доработка ${round}`,
      }));
      added = this.graph.addPlanned(tasks).map((t) => t.id);
      this.classifyPools('доработка');
    }
    this.journal.record({ type: 'rework', round, note, missing: prevMissing, added, error: res?.ok ? undefined : (res?.errors ?? ['планировщик не ответил']).join('; ').slice(0, 300) });
    this.emit({ kind: 'phase', phase: 'running' });
  }

  /**
   * Факты о результате по ВСЕМ файлам, а не по обрезанному diff: сколько файлов какого вида изменено
   * и что из старого исчезло совсем (тег <table было в 16 файлах — осталось в 0). Приёмка иначе видит только начало diff
   * и пишет «таблицы заменены только на одной странице», когда они заменены везде.
   */
  private async runFacts(): Promise<string[]> {
    const out: string[] = [];
    const ref = this.ws.integration;
    const changed = (await changedFiles(this.o.repo, { base: this.runBase, branch: ref }).catch(() => [] as ChangedFile[])).map((c) => c.file);
    if (!changed.length) return out;
    // изменённые файлы по видам (шаблонам пути)
    const groups: { glob: string; files: string[] }[] = [];
    for (const f of changed) {
      const g = groups.find((x) => x.files.length && (x.files[0] === f || fileTemplate(x.files[0]!, f)));
      if (g) {
        if (g.files.length === 1) g.glob = fileTemplate(g.files[0]!, f)!.glob;
        g.files.push(f);
      } else groups.push({ glob: f, files: [f] });
    }
    const big = groups.filter((g) => g.files.length > 1).sort((a, b) => b.files.length - a.files.length);
    if (big.length) out.push(`изменены однотипные файлы: ${big.slice(0, 6).map((g) => `${g.glob} — ${g.files.length} шт.`).join('; ')}; всего изменено файлов: ${changed.length}`);
    // что из старого исчезло: теги и классы, которые были в изменённых файлах до прогона и пропали
    const gone = new Map<string, number>();
    for (const f of changed.slice(0, 80)) {
      const before = await git(this.o.repo, ['show', `${this.runBase}:${f}`], true);
      const after = await git(this.o.repo, ['show', `${ref}:${f}`], true);
      if (!before) continue;
      const mb = markersOf(before);
      const ma = markersOf(after);
      for (const m of mb) if (!ma.has(m) && !m.startsWith('</')) gone.set(m, (gone.get(m) ?? 0) + 1);
    }
    for (const [m, n] of [...gone].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      if (n < 2) continue;
      const left = (await git(this.o.repo, ['grep', '-l', '-F', m, ref, '--', ':!node_modules', ':!*.lock', ':!package-lock.json'], true)).split('\n').filter(Boolean).map((l) => l.replace(`${ref}:`, ''));
      const leftSame = left.filter((f) => /\.(tsx?|jsx?|vue|svelte|html?)$/.test(f));
      out.push(`«${m}» убрано из ${n} файлов; в коде проекта осталось в ${leftSame.length} файл(ах)${leftSame.length ? `: ${leftSame.slice(0, 5).join(', ')}${leftSame.length > 5 ? ', …' : ''}` : ' — нигде'}`);
    }
    return out;
  }

  /** Чего не хватало по последней приёмке этого прогона (из журнала событий). */
  private lastMissingFromJournal(): string[] {
    try {
      const lines = readFileSync(path.join(this.runDir, 'events.jsonl'), 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const e = JSON.parse(lines[i]!).event as { type: string; achieved?: boolean | null; missing?: string[] };
        if (e.type === 'goal-check') return e.achieved === false ? (e.missing ?? []) : [];
      }
    } catch {
      /* журнала нет */
    }
    return this.lastGoal?.achieved === false ? this.lastGoal.missing : [];
  }

  // ---------- копилка решений (skills/learned) ----------

  /** Пакеты проекта с версиями: корень и все node-части (web/package.json), плюс поставленные в прогоне. */
  private projectDeps(): Record<string, string> {
    const dirs = (this.map?.stacks ?? []).filter((s) => s.id === 'node').map((s) => s.dir);
    return { ...dependencyVersions(this.o.repo, dirs), ...Object.fromEntries(this.installed_) };
  }

  private errorTags(t: Task, output: string): string[] {
    const dir = t.workdir && existsSync(t.workdir) ? t.workdir : this.o.repo;
    const imports = t.files.flatMap((f) => {
      try {
        return importedPackages(readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        return [];
      }
    });
    return tagsFor(output, { files: t.files, imports, deps: this.projectDeps() });
  }

  /** Ошибка проверок: есть ли в копилке такое решение — сразу в справку исполнителю (без сети и без ожидания). */
  private checkBook(t: Task, signature: string, output: string): void {
    const key = fixKey(signature);
    if ((t.bookChecked ?? []).includes(key)) return;
    t.bookChecked = [...(t.bookChecked ?? []), key];
    const error = cleanError(output);
    const hits = this.book.search({ text: error, tags: this.errorTags(t, output) });
    if (!hits.length) return;
    const text = `Это уже решали раньше (копилка skills/learned):\n${SolutionBook.render(hits.map((h) => h.s))}`;
    t.reference = t.reference ? `${text}\n\n${t.reference}` : text;
    this.journal.record({ type: 'learned-hit', taskId: t.id, titles: hits.map((h) => h.s.title), sections: hits.map((h) => h.s.section) });
  }

  /** Задача прошла после ошибки проверок — записать, что помогло. */
  private async recordSolution(t: Task, prev: string, head: string, changes: FileChange[], facts: string[], by?: string): Promise<void> {
    const output = t.lastCheckError!;
    const error = cleanError(output);
    if (error.length < 8) return;
    const tags = this.errorTags(t, output);
    const names = [...output.matchAll(/'([A-Za-z_$][\w$]{2,})'/g)].map((m) => m[1]!);
    const errFiles = changes.map((c) => c.file).filter((f) => output.includes(f));
    const diff = await git(this.o.repo, ['diff', '--no-color', '-U1', `${prev}..${head}`, '--', ...(errFiles.length ? errFiles : changes.map((c) => c.file).slice(0, 3))], true);
    const sources = [...new Set((t.reference ?? '').match(/https?:\/\/[^\s)]+/g) ?? [])].slice(0, 3);
    const code = tags.find((x) => /^(ts\d{4}|e[a-z]{3,}|[a-z]+error)$/.test(x));
    const fix = [...(t.lastNote ? [`исполнитель: ${t.lastNote.slice(0, 200)}`] : []), ...facts.filter((f) => !f.startsWith('исполнитель:')).slice(0, 5)];
    if (!fix.length) return;
    const section = sectionOf(t.lastCheckSig!);
    const res = this.book.add({
      id: solutionId(error, tags),
      section,
      title: titleFor(output, code),
      tags,
      error,
      fix,
      ...(diff ? { example: exampleFromDiff(diff, names) } : {}),
      ...(sources.length ? { sources } : {}),
      where: `${path.basename(this.o.repo)}: ${t.id}${by ? `, ${by}` : ''}`,
    });
    t.lastCheckError = undefined;
    this.journal.record({ type: 'learned', taskId: t.id, section, title: res.solution.title, fresh: res.fresh, file: res.file ? path.relative(path.dirname(path.dirname(path.dirname(res.file))), res.file).split(path.sep).join('/') : null });
  }

  // ---------- справка по ошибке, задачи «менять нечего» ----------

  /** Справка перед следующей попыткой: объявления типов библиотек (без сети) и поиск в интернете по тексту ошибки. */
  private async lookup(t: Task): Promise<void> {
    t.needsLookup = false;
    t.lookedUp = [...(t.lookedUp ?? []), fixKey(t.failures.at(-1) ?? '')];
    const out = t.lastError ?? '';
    const parts: string[] = [];
    this.activity('gpu', { taskId: t.id, role: 'scout' }, 'ошибка повторяется — ищет справку: типы библиотек и интернет');
    const dir = t.workdir && existsSync(t.workdir) ? t.workdir : this.o.repo;
    const file = t.files.find((f) => out.includes(f)) ?? t.files[0];
    let fileText = '';
    try {
      if (file) fileText = readFileSync(path.join(dir, file), 'utf8');
    } catch {
      /* файла нет */
    }
    const local = fileText ? localTypeHelp(this.o.repo, fileText, out) : null;
    if (local) parts.push(`Объявления типов из установленных библиотек (точно для этой версии):\n\`\`\`ts\n${local}\n\`\`\``);
    let query = '';
    let hits: { title: string; url: string; snippet: string }[] = [];
    let pages = 0;
    if (this.o.webLookup && !process.env.AGENTYARD_OFFLINE) {
      const deps = this.projectDeps();
      // библиотека ошибки: где объявлен тип из ошибки, иначе — чей вызов стоит в строке с ошибкой
      const libs = [...packagesOfHelp(local), ...(fileText ? [libraryOfError(fileText, out)].filter((x): x is string => !!x) : [])];
      query = errorQuery(out, deps, libs);
      if (query.length > 8) {
        this.activity('gpu', { taskId: t.id, role: 'scout' }, `ищет в интернете: «${query.slice(0, 90)}»`);
        hits = await webSearch(query).catch(() => []);
        if (hits.length) this.activity('gpu', { taskId: t.id, role: 'scout' }, `нашёл ${hits.length} ссылок — читает страницы: ${hits.slice(0, 2).map((h) => h.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 50)).join(', ')}`);
        const terms = [...propsFromError(out), ...typeNamesFromError(out), ...(out.match(/TS\d{4}/) ?? [])];
        const ex: string[] = [];
        for (const h of hits.slice(0, 4)) {
          if (ex.length >= 2) break;
          const e = await pageExcerpt(h.url, terms.length ? terms : query.split(' ').slice(0, 3));
          if (e) ex.push(`${h.title} — ${h.url}\n${e}`);
        }
        pages = ex.length;
        if (hits.length) parts.push(`Поиск в интернете «${query}»:\n${hits.slice(0, 5).map((h) => `- ${h.title} (${h.url})${h.snippet ? `: ${h.snippet}` : ''}`).join('\n')}${ex.length ? `\n\nВыдержки со страниц:\n${ex.join('\n\n')}` : ''}`);
      }
    }
    this.activity('gpu', {}, null);
    if (parts.length) t.reference = parts.join('\n\n').slice(0, 7000);
    this.journal.record({ type: 'lookup', taskId: t.id, local: !!local, query, hits: hits.length, pages, urls: hits.slice(0, 3).map((h) => h.url) });
  }

  /** Команды критерия задачи: её тесты и команды, кроме самодельных и дублей проверки типов (она идёт отдельно, с учётом старых ошибок). */
  private criterionCommands(t: Task): { cmd: string; strict: boolean }[] {
    const tests = testCommandsFor(t.accept.tests, this.map.stacks, this.map.commands);
    return [
      // команда ровно тестов задачи: их падение — провал задачи, даже если они падали и раньше
      ...tests.commands.map((cmd) => ({ cmd, strict: tests.specific })),
      // своя команда задачи — строго; команда на весь проект — с учётом старых падений
      ...t.accept.commands.filter((c) => isCheckCommand(c, this.map.commands) && !isRedundantCheck(c, this.map.commands)).map((cmd) => ({ cmd, strict: !isProjectWide(cmd, this.map.stacks, this.map.commands) })),
    ];
  }

  /**
   * Команда критерия. null — прошла. Падение только на ошибках, которые были в проекте до прогона, — не провал:
   * прогон 20261020112744 застрял, потому что «tsc» в критерии падал на двух старых ошибках чужих форм,
   * а исполнители и аналитик чинили эти формы вместо своей задачи.
   */
  private async runCriterion(cmd: string, dir: string, strict = false): Promise<string | null> {
    const r = await runCommand(cmd, dir);
    if (r.code === 0) return null;
    if (strict) return `Команда: ${cmd}\n${r.output}`;
    const lines = errorLines(r.output);
    const known = new Map<string, number>();
    for (const m of [this.knownErrors.typecheck, this.knownErrors.lint]) for (const [k, n] of m ?? []) known.set(k, (known.get(k) ?? 0) + n);
    if (lines.length && known.size && newErrors(lines, known).length === 0) return null;
    // любая команда (тесты тоже): падала так же и до прогона — не провал
    const cmp = await this.compareWithBase(cmd, r).catch(() => null);
    if (cmp?.preexisting) return null;
    return `Команда: ${cmd}\n${cmp?.fresh.length ? `Новые падения:\n${cmp.fresh.slice(0, 30).join('\n')}\n\n` : ''}${r.output}`;
  }

  /** Проверки задачи на текущем коде без правки: признаки готовности, тесты и команды задачи. null — всё проходит. */
  private async verifyUnchanged(t: Task, dir: string | null): Promise<string | null> {
    const where = dir ?? (await this.ws.integrationWorktree());
    try {
      const notDone = doneWhenProblems(t.doneWhen, where);
      if (notDone) return notDone;
      for (const { cmd, strict } of this.criterionCommands(t)) {
        const failed = await this.runCriterion(cmd, where, strict);
        if (failed) return failed;
      }
      return null;
    } finally {
      if (!dir) await this.ws.removeWorktree(where);
    }
  }

  /** Закрыть задачу без правки (менять нечего): в ветку сборки ничего не вливается, цепочка идёт дальше. */
  private closeDone(t: Task, why: string): void {
    this.activity(`cpu:${t.id}`, {}, null);
    this.humanReasons.delete(t.id);
    t.doneBy = why.startsWith('человек') ? 'человек' : 'программа';
    this.decisions.add({ taskId: t.id, title: t.title, facts: [why], files: t.files, by: t.doneBy, pool: t.pool, parent: t.parent });
    this.journal.record({ type: 'self-help', taskId: t.id, what: `закрыта без правки — ${why}` });
    if (t.workdir) {
      const { workdir, branch } = t;
      t.workdir = undefined;
      t.branch = undefined;
      this.ws.removeWorktree(workdir).catch(() => undefined);
      if (branch) this.ws.deleteBranch(branch).catch(() => undefined);
    }
    // составная задача закрыта целиком — её недоделанные части тоже не нужны
    for (const part of this.graph.parts(t.id)) {
      if (part.status === 'done') continue;
      this.humanReasons.delete(part.id);
      part.doneBy = t.doneBy;
      part.status = 'done';
    }
    this.graph.setStatus(t.id, 'done');
    this.reviveBlocked();
  }

  // ---------- пулы однотипных задач: одно решение на всех ----------

  /** Классификатор (pools.ts): однотипные не начатые задачи → пул; остальные пула ждут образец. */
  private classifyPools(where: string): void {
    const plans = classify(this.graph.all());
    for (const p of plans) {
      this.pools.set(p.leader, { id: p.leader, leader: p.leader, members: p.members, promotions: 0, glob: p.glob });
      for (const id of p.members) {
        const t = this.graph.get(id);
        t.pool = p.leader;
        if (id === p.leader) continue;
        if (!t.dependsOn.includes(p.leader)) t.dependsOn.push(p.leader);
        if (t.status === 'ready') t.status = 'waiting';
      }
      this.journal.record({ type: 'pool', id: p.leader, leader: p.leader, members: p.members, glob: p.glob, where });
    }
    if (plans.length) {
      this.graph.recomputeWeights();
      this.graph.onChange?.();
    }
  }

  /** Где задача в общей работе — исполнителю и ревьюеру, чтобы не делали чужое и не требовали чужого. */
  private scopeOf(t: Task): string | undefined {
    const lines: string[] = [];
    const st: Record<string, string> = { waiting: 'ждёт', ready: 'в очереди', running: 'в работе', checking: 'на проверках', review: 'на ревью', done: 'готова', human: 'у человека' };
    if (t.parent) {
      const p = this.graph.tasks.get(t.parent);
      if (p) {
        const sib = (p.children ?? []).filter((c) => c !== t.id).map((c) => this.graph.tasks.get(c)).filter((x): x is Task => !!x);
        lines.push(`Это часть задачи ${p.id} «${p.title}».${sib.length ? ` Другие части: ${sib.map((x) => `${x.id} «${x.title.slice(0, 60)}» (${st[x.status]})`).join(', ')}.` : ''} Делай только свою часть — задача ${p.id} соберётся из всех частей.`);
      }
    }
    if (t.pool) {
      const others = (this.pools.get(t.pool)?.members ?? []).filter((m) => m !== t.id && this.graph.tasks.has(m));
      if (others.length) lines.push(`Это одна из ${others.length + 1} однотипных задач (пул ${t.pool}): та же правка в других файлах делается отдельно${t.solutionFrom ? ` — по решению, уже принятому в ${t.solutionFrom}` : ''}. Здесь — только ${t.files.join(', ')}.`);
    }
    if (t.similar) lines.push(`Правится только образец ${t.files[0]}; после слияния программа сама повторит правку в остальных файлах по шаблону ${t.similar}.`);
    return lines.length ? lines.join('\n') : undefined;
  }

  private taskContext(t: Task, role: Role): TaskContext {
    const ds = this.decisions.relevant(t, this.graph.tasks);
    const fix = role === 'reviewer' ? undefined : this.decisions.fixFor(t);
    return {
      scope: this.scopeOf(t),
      decisions: ds.length ? DecisionLog.render(ds) : undefined,
      solution: t.solutionFrom ? this.solutions.get(t.solutionFrom) : undefined,
      fix: fix ? `${fix.taskId} падала на той же ошибке и справилась так: ${fix.facts.join('; ')}` : undefined,
    };
  }

  /**
   * Повтор принятого решения программой. Для каждой группы файлов (одна задача пула или один файл шаблона):
   * все файлы группы подошли под правила — группа применена; потом общие проверки; файлы, на которые указывают
   * ошибки, откатываются вместе со своей группой; остальное — коммит и слияние. Вызывается под замком слияния.
   */
  private async applyTirage(
    owner: Task,
    groups: { key: string; task?: Task; units: { example: string; target: string; glob: string }[] }[],
    rules: Map<string, RuleSet>,
  ): Promise<{ applied: string[]; skipped: string[]; failed: { key: string; why: string; leftovers: string[] }[]; commits: Map<string, string> }> {
    const commits = new Map<string, string>();
    const applied: string[] = [];
    const skipped: string[] = [];
    const failed: { key: string; why: string; leftovers: string[] }[] = [];
    if (!groups.length) return { applied, skipped, failed, commits };
    const { dir, branch } = await this.ws.createTaskWorktree(`${owner.id}~tirage`);
    try {
      const written = new Map<string, string[]>();
      for (const g of groups) {
        const outs: { target: string; text: string }[] = [];
        let why = '';
        let leftovers: string[] = [];
        let nothing = 0;
        for (const u of g.units) {
          const rs = rules.get(u.example);
          const abs = path.join(dir, u.target);
          if (!rs || !existsSync(abs) || !rs.exact) {
            // правила, которые не воспроизводят сам образец, вслепую не применяем — только шаги для модели
            why = !rs ? 'для этого файла образца нет правил' : !rs.exact ? 'правка образца не сводится к простым заменам' : 'файла нет';
            break;
          }
          const o = applyRules(readFileSync(abs, 'utf8'), rs, entityPairs(u.glob, u.example, u.target));
          if (o.nothingToDo) {
            nothing++;
            continue;
          }
          if (!fits(o)) {
            leftovers = o.leftovers;
            why = o.leftovers.length ? `остались ${o.leftovers.slice(0, 3).join(', ')}` : o.unmet.length ? 'не нашлось места для вставки' : 'правила ничего не поменяли';
            break;
          }
          outs.push({ target: u.target, text: o.text });
        }
        if (why) failed.push({ key: g.key, why, leftovers });
        else if (!outs.length && nothing === g.units.length) skipped.push(g.key);
        else if (outs.length) {
          for (const x of outs) writeFileSync(path.join(dir, x.target), x.text);
          written.set(g.key, outs.map((x) => x.target));
        } else failed.push({ key: g.key, why: 'менять нечего только в части файлов', leftovers: [] });
      }
      const all = () => [...written.values()].flat();
      const check = () =>
        runCascade({
          task: { ...owner, doneWhen: undefined, frozenFiles: [] },
          workdir: dir,
          changedFiles: all(),
          changedLines: 0,
          maxChangedLines: Number.MAX_SAFE_INTEGER,
          ...this.checkEnv(owner, all()),
          onStage: (x) => this.activity(`cpu:${owner.id}`, { taskId: owner.id }, `повтор по образцу: ${x}`),
        });
      for (let round = 0; round < 3 && written.size; round++) {
        const r = await check();
        if (r.passed) break;
        // ошибки указывают на конкретные файлы — откатываем их группы, остальное проверяем ещё раз
        const bad = [...written].filter(([, fs]) => fs.some((f) => r.output.includes(f) || r.output.includes(f.replace(/\//g, '\\'))));
        const drop = bad.length && bad.length < written.size && round < 2 ? bad : [...written];
        for (const [key, fs] of drop) {
          await git(dir, ['checkout', '--', ...fs], true);
          written.delete(key);
          // причина — строка ошибки про этот файл, а не заголовок npm
          const own = r.output.split(/\r?\n/).find((l) => fs.some((f) => l.includes(f) || l.includes(f.replace(/\//g, '\\'))));
          failed.push({ key, why: `проверки: ${(own ?? firstLine(r.output)).trim().slice(0, 160)}`, leftovers: [] });
        }
      }
      this.activity(`cpu:${owner.id}`, {}, null);
      if (written.size) {
        // каждая задача пула — своим коммитом (откат и поиск виновного точные); файлы шаблона — одним
        for (const [key, fs] of written) {
          const g = groups.find((x) => x.key === key)!;
          await git(dir, ['add', '--', ...fs]);
          const id = g.task?.id ?? owner.id;
          await git(dir, ['-c', 'user.name=AgentYard', '-c', 'user.email=agentyard@localhost', 'commit', '-q', '-m', `${id}: ${g.task ? g.task.title : `${owner.title} — по образцу`}\n\nСделано программой: повтор решения из ${owner.id}.`]);
          commits.set(key, await git(dir, ['rev-parse', 'HEAD']));
          applied.push(key);
        }
        await this.ws.fastForwardIntegration(branch);
      }
    } finally {
      await this.ws.removeWorktree(dir);
      await this.ws.deleteBranch(branch);
    }
    return { applied, skipped, failed, commits };
  }

  /** Правила из слияния задачи: текст каждого её файла до и после. */
  private async rulesOf(files: string[], prev: string): Promise<Map<string, RuleSet>> {
    const out = new Map<string, RuleSet>();
    for (const f of files) {
      const before = await git(this.o.repo, ['show', `${prev}:${f}`], true);
      const after = await git(this.o.repo, ['show', `${this.ws.integration}:${f}`], true);
      if (!before || !after || before === after) continue;
      const rs = learnRules(before, after);
      if (rs.subs.length || rs.inserts.length || rs.removes.length) out.set(f, rs);
    }
    return out;
  }

  /** Diff решения для показа исполнителям, которые его повторяют. */
  private async rememberSolution(t: Task, prev: string, files: string[]): Promise<void> {
    const diff = await git(this.o.repo, ['diff', '--no-color', '-U2', `${prev}..${this.ws.integration}`, '--', ...files], true);
    if (diff) this.solutions.set(t.id, diff.length > 6000 ? `${diff.slice(0, 6000)}\n… (обрезано)` : diff);
  }

  /** Правка по образцу (similar): образец влит — программа повторяет его в остальных файлах шаблона; не подошедшие — атомы пула. */
  private async tirageSimilar(t: Task, prev: string): Promise<void> {
    const example = t.files[0]!;
    const rules = await this.rulesOf([example], prev);
    await this.rememberSolution(t, prev, [example]);
    const files = (await git(this.o.repo, ['ls-tree', '-r', '--name-only', this.ws.integration], true)).split('\n').filter(Boolean);
    // файлы, у которых уже есть своя задача пула (переделка образца) — не дублируем
    const covered = new Set(this.graph.all().filter((x) => x.pool === t.id && x.id !== t.id).flatMap((x) => x.files));
    const targets = matchFiles(t.similar!, files).filter((f) => f !== example && !t.frozenFiles.includes(f) && !covered.has(f));
    const rs = rules.get(example);
    if (!targets.length) return;
    if (!rs) {
      // образец не изменился (правили, например, общий CSS) — повторять в остальных файлах нечего
      this.journal.record({ type: 'tirage', taskId: t.id, from: example, applied: [], skipped: targets.length, failed: [], added: [], exact: true });
      return;
    }
    const res = rs
      ? await this.applyTirage(t, targets.map((f) => ({ key: f, units: [{ example, target: f, glob: t.similar! }] })), rules)
      : { applied: [], skipped: [], failed: targets.map((f) => ({ key: f, why: 'образец не изменился', leftovers: [] as string[] })), commits: new Map<string, string>() };
    // остаток: одна задача — один файл (атом), с подробными шагами и признаками готовности из правил образца
    const short = (f: string) => f.split('/').pop() ?? f;
    const tasks: PlannedTask[] = res.failed.map((f, i) => {
      const pairs = entityPairs(t.similar!, example, f.key);
      return {
        id: this.freeId(`${t.id}.p${i + 1}`),
        type: 'edit',
        title: `${t.title.replace(/\s+—\s+.*$/, '').slice(0, 70)}: ${short(f.key)}`,
        brief: `Сделай в ${f.key} ту же правку, что уже принята и влита в ${example} (задача ${t.id}). Только этот файл: остальные однотипные файлы уже сделала программа или делают соседние задачи пула.\nПрограмма сама повторить не смогла: ${f.why}.`,
        dependsOn: [],
        files: [f.key],
        accept: { tests: [...t.accept.tests], commands: [...t.accept.commands] },
        size: 'S',
        pool: t.id,
        solutionFrom: t.id,
        ...(rs ? { steps: rulesSteps(rs, f.key, pairs, f.leftovers), doneWhen: [rulesDoneWhen(rs, f.key, pairs)] } : {}),
      };
    });
    const added = tasks.length ? this.graph.addPlanned(tasks, Date.now(), t.id).map((x) => x.id) : [];
    if (added.length) {
      const pm = this.pools.get(t.id) ?? { id: t.id, leader: t.id, members: [t.id], promotions: 0, glob: t.similar };
      pm.members = [...new Set([...pm.members, ...added])];
      this.pools.set(t.id, pm);
    }
    this.journal.record({ type: 'tirage', taskId: t.id, from: example, applied: res.applied, skipped: res.skipped.length, failed: res.failed.map((f) => ({ file: f.key, why: f.why })), added, exact: rs?.exact ?? false });
    if (rs) this.decisions.add({ ...(this.decisions.get(t.id) ?? { taskId: t.id, title: t.title, facts: [], files: [example] }), facts: [...(this.decisions.get(t.id)?.facts ?? []).slice(0, 5), `решение: ${rulesSummary(rs).join('; ')}`, ...(res.applied.length ? [`программа повторила его ещё в ${res.applied.length} файлах`] : [])] });
  }

  /**
   * Задача пула влита (образец, человек или очередной файл) — её решение повторяется в не начатых задачах пула.
   * Каждый сделанный файл учит программу: следующие пробуют уже по свежему решению («снежный ком»).
   */
  private async tiragePool(from: Task, prev: string): Promise<void> {
    const pm = from.pool ? this.pools.get(from.pool) : undefined;
    if (!pm) return;
    const waiting = pm.members
      .map((id) => this.graph.tasks.get(id))
      .filter((x): x is Task => !!x && x.id !== from.id && !started(x) && !x.children?.length && (x.status === 'waiting' || x.status === 'ready' || (x.status === 'human' && blockedReason(this.humanReasons.get(x.id)))));
    if (!waiting.length) return;
    await this.tiragePoolInner(from, prev, waiting, pm.leader === from.id);
  }

  private async tiragePoolInner(from: Task, prev: string, waiting: Task[], leader: boolean): Promise<void> {
    const changed = (await git(this.o.repo, ['diff', '--name-only', `${prev}..${this.ws.integration}`], true)).split('\n').filter((f) => f && from.files.includes(f));
    if (!changed.length) return;
    const rules = await this.rulesOf(changed, prev);
    await this.rememberSolution(from, prev, changed);
    // файлы задачи ↔ файлы образца: один шаблон пути, одно имя сущности
    const groups = waiting.flatMap((w) => {
      const units: { example: string; target: string; glob: string }[] = [];
      for (const f of w.files) {
        const ex = changed.map((e) => ({ e, tpl: fileTemplate(e, f) })).find((x) => x.tpl);
        if (!ex) return [];
        units.push({ example: ex.e, target: f, glob: ex.tpl!.glob });
      }
      return units.length ? [{ key: w.id, task: w, units }] : [];
    });
    // быстрая проба в памяти: какие задачи решение берёт целиком. Рабочую копию и проверки — только для них,
    // и только их придерживаем от модели (остальные модель может брать, не дожидаясь программы)
    const pre: { key: string; why: string; leftovers: string[] }[] = [];
    const fitting: typeof groups = [];
    for (const g of groups) {
      let why = '';
      let leftovers: string[] = [];
      let nothing = 0;
      for (const u of g.units) {
        const rs = rules.get(u.example);
        if (!rs || !rs.exact) {
          why = !rs ? 'правил нет' : 'правка образца не сводится к простым заменам';
          break;
        }
        const text = await git(this.o.repo, ['show', `${this.ws.integration}:${u.target}`], true);
        const o = applyRules(text, rs, entityPairs(u.glob, u.example, u.target));
        if (o.nothingToDo) nothing++;
        else if (!fits(o)) {
          leftovers = o.leftovers;
          why = o.leftovers.length ? `остались ${o.leftovers.slice(0, 3).join(', ')}` : o.unmet[0] ?? 'не подошло';
          break;
        }
      }
      if (why || nothing === g.units.length) pre.push({ key: g.key, why: why || 'менять нечего', leftovers });
      else if (!started(g.task!)) fitting.push(g);
    }
    for (const g of fitting) this.tiraging.add(g.key);
    let res;
    try {
      res = fitting.length ? await this.applyTirage(from, fitting, rules) : { applied: [] as string[], skipped: [] as string[], failed: [] as { key: string; why: string; leftovers: string[] }[], commits: new Map<string, string>() };
    } finally {
      for (const g of fitting) this.tiraging.delete(g.key);
    }
    res.failed.push(...pre);
    for (const id of res.applied) {
      const w = this.graph.get(id);
      w.doneBy = `программа (по образцу ${from.id})`;
      w.solutionFrom = from.id;
      this.humanReasons.delete(id);
      this.decisions.add({ taskId: id, title: w.title, facts: [`сделано программой по решению ${from.id}`], files: w.files, by: 'программа', pool: w.pool });
      this.mergedHere += 1;
      this.graph.setStatus(id, 'done');
      this.journal.record({ type: 'merged', taskId: id, commit: res.commits.get(id) ?? (await this.ws.sha(this.ws.integration)) });
    }
    // не подошло — задача идёт к модели, но уже с решением, шагами и признаками готовности
    for (const f of res.failed) {
      const w = this.graph.tasks.get(f.key);
      const g = groups.find((x) => x.key === f.key);
      if (!w || !g) continue;
      w.solutionFrom = from.id;
      w.steps = g.units.flatMap((u) => (rules.get(u.example) ? rulesSteps(rules.get(u.example)!, u.target, entityPairs(u.glob, u.example, u.target), f.leftovers) : []));
      w.doneWhen = g.units.flatMap((u) => (rules.get(u.example) ? [rulesDoneWhen(rules.get(u.example)!, u.target, entityPairs(u.glob, u.example, u.target))] : []));
      if (!w.brief.includes('Программа сама повторить не смогла')) w.brief += `\n\nРешение уже принято в ${from.id}: повтори его здесь. Программа сама повторить не смогла: ${f.why}.`;
    }
    // снежный ком без толку (ни одна не подошла) — в журнал не пишем: шум «не подошло в 13 задачах» после каждого файла
    if (res.applied.length || (leader && res.failed.length)) {
      this.journal.record({ type: 'tirage', taskId: from.id, from: changed.join(', '), applied: [], done: res.applied, skipped: res.skipped.length, failed: res.failed.map((f) => ({ file: f.key, why: f.why })), added: [], exact: [...rules.values()].every((r) => r.exact) });
    }
    this.graph.onChange?.();
  }

  /** Свободный id: T2.p1, а если занят — T2.p1b, T2.p1c… (без бесконечных штрихов). */
  private freeId(id: string): string {
    if (!this.graph.tasks.has(id)) return id;
    for (const c of 'bcdefghijk') if (!this.graph.tasks.has(`${id}${c}`)) return `${id}${c}`;
    return `${id}-${Date.now().toString(36)}`;
  }

  /** Образец пула ушёл к человеку: образцом становится следующая задача пула (один раз). */
  private promoteLeader(t: Task, why: string): void {
    const pm = t.pool ? this.pools.get(t.pool) : undefined;
    if (!pm || pm.leader !== t.id || blockedReason(why)) return;
    const rest = pm.members
      .map((id) => this.graph.tasks.get(id))
      .filter((x): x is Task => !!x && x.id !== t.id && !started(x) && x.status === 'waiting')
      .sort((a, b) => ((a.seq ?? '') < (b.seq ?? '') ? -1 : 1));
    if (!rest.length) return;
    if (pm.promotions >= 1) {
      this.journal.record({ type: 'pool-promote', pool: pm.id, from: t.id, to: null, why: firstLine(why) });
      return; // остальные остаются ждать этот образец: человек сделает его — программа повторит в них
    }
    const next = rest[0]!;
    pm.promotions += 1;
    pm.leader = next.id;
    next.dependsOn = next.dependsOn.filter((d) => d !== t.id);
    next.brief += `\n\nПрежний образец ${t.id} не получился: ${firstLine(why)}. Учти это и не повторяй тот путь.`;
    for (const o of rest.slice(1)) o.dependsOn = [...new Set(o.dependsOn.map((d) => (d === t.id ? next.id : d)))];
    this.journal.record({ type: 'pool-promote', pool: pm.id, from: t.id, to: next.id, why: firstLine(why) });
    this.graph.recomputeWeights();
    this.graph.refreshReady();
  }

  /**
   * Сборка матрёшки: все части составной задачи сделаны — проверяем её собственный критерий на ветке сборки
   * и поднимаем решения частей наверх. Не прошло — одна добавочная часть «довести до критерия», потом человек.
   */
  private async assembleComposites(): Promise<void> {
    for (const c of this.graph.assemblable()) {
      const parts = c.children!.map((id) => this.graph.get(id));
      const cmds = this.criterionCommands(c);
      let failed: string | null = null;
      if (cmds.length || c.doneWhen?.length) {
        const dir = await this.ws.integrationWorktree();
        try {
          failed = doneWhenProblems(c.doneWhen, dir);
          for (const { cmd, strict } of failed ? [] : cmds) {
            this.activity(`cpu:${c.id}`, { taskId: c.id }, `сборка из частей: ${cmd}`);
            failed = await this.runCriterion(cmd, dir, strict);
            if (failed) break;
          }
        } finally {
          this.activity(`cpu:${c.id}`, {}, null);
          await this.ws.removeWorktree(dir);
        }
      }
      if (failed) {
        c.assembleTries = (c.assembleTries ?? 0) + 1;
        if (c.assembleTries >= 2) {
          this.journal.record({ type: 'assembled', taskId: c.id, parts: c.children!, ok: false, why: firstLine(failed) });
          this.toHuman(c, `собрана из частей, но не проходит свой критерий: ${firstLine(failed)}`);
          continue;
        }
        const id = this.freeId(`${c.id}.${c.children!.length + 1}`);
        const files = [...new Set(parts.flatMap((p) => p.files))].slice(0, this.limits.maxFiles);
        this.graph.split(c.id, [{ id, type: 'edit', title: `Довести «${c.title.slice(0, 60)}» до критерия`, brief: `Все части задачи ${c.id} сделаны, но её критерий не проходит:\n${failed.slice(0, 1500)}\n\nИсправь причину, опираясь на принятые решения частей.`, dependsOn: [], files, accept: { tests: [...c.accept.tests], commands: [...c.accept.commands] }, size: 'S' }]);
        this.journal.record({ type: 'assembled', taskId: c.id, parts: parts.map((p) => p.id), ok: false, why: firstLine(failed), added: [id] });
        continue;
      }
      // подъём вверх: решения частей становятся решением задачи
      const facts = [...new Set(parts.flatMap((p) => this.decisions.get(p.id)?.facts ?? []))].slice(0, 8);
      const files = [...new Set(parts.flatMap((p) => this.decisions.get(p.id)?.files ?? p.files))];
      this.decisions.add({ taskId: c.id, title: c.title, facts: [`собрана из ${c.children!.join(', ')}`, ...facts], files, by: 'сборка из частей', pool: c.pool, parent: c.parent });
      c.doneBy = 'сборка из частей';
      this.graph.setStatus(c.id, 'done');
      this.journal.record({ type: 'assembled', taskId: c.id, parts: c.children!, ok: true });
      // составной образец: его общее решение — остальным задачам пула и остальным файлам шаблона
      const base = this.baseSha.get(`${c.id}#split`) ?? this.runBase;
      // правка по образцу могла появиться только у частей (другой подход) — повторяем решение целиком
      const sim = c.similar ?? parts.find((p) => p.similar)?.similar;
      const example = c.similar ? c.files[0] : parts.find((p) => p.similar)?.files[0];
      if (sim && example && !c.parent) await this.tirageSimilar({ ...c, similar: sim, files: [example, ...c.files.filter((f) => f !== example)] }, base);
      if (c.pool) await this.tiragePool({ ...c, files }, base);
    }
  }

  // ---------- уровень 6: лестница эскалации ----------

  /**
   * Неудача шага. Сначала — чья она (engine/triage.ts) и что делать (engine/policy.ts): окружение чинит программа,
   * сбой Ollama и старые падения проекта попытку не тратят, модель, которая сходится, не дёргаем ступенями,
   * зациклившуюся — сразу выше. Лестница — только для неудач самой модели.
   */
  private fail(t: Task, signature: string, output: string, hintStep?: number): void {
    this.activity(`cpu:${t.id}`, {}, null);
    const tri = triage(signature, output, { taskFiles: [...t.files, ...(t.newFiles ?? [])], changedFiles: t.lastChanged ?? [], projectFiles: this.map.files });
    const now: AttemptLog = { sig: signature, cls: tri.cls, stage: stageOf(signature), errors: tri.errors, patch: t.lastPatchHash, model: t.lastModel };
    const d = decide({ history: t.attemptLog ?? [], now, triage: tri, ladderStep: t.ladderStep, attempts: t.attempts, maxAttempts: ESCALATION.maxAttempts, canInstall: !!this.o.allowInstall, hintStep });
    t.attemptLog = [...(t.attemptLog ?? []), now].slice(-12);
    t.lastPatchHash = undefined;
    t.lastError = output;
    this.journal.record({
      type: 'triage',
      taskId: t.id,
      cls: tri.cls,
      why: tri.why,
      decision: d.action === 'retry' ? `ступень ${d.step}${d.count ? '' : ', попытка не засчитана'}${d.otherModel ? ', другая модель' : ''} — ${d.why}` : d.why,
    });
    if (d.action === 'install') {
      // правка верная, не хватает пакета: ставит программа перед следующим заходом, попытка не тратится
      t.install = [...new Set([...(t.install ?? []), ...d.packages])];
      this.graph.setStatus(t.id, 'ready');
      return;
    }
    if (d.action === 'human') {
      this.toHuman(t, d.why);
      return;
    }
    // статистика моделей — только по неудачам самой модели, не по окружению, сбоям Ollama и старым падениям проекта
    if (d.count && t.attempts === 0 && t.lastModel && ['own', 'collateral', 'format'].includes(tri.cls)) this.o.stats.recordOutcome(t.lastModel, t.role, t.size, false);
    if (d.count) t.attempts += 1;
    if (d.otherModel) {
      const other = this.team.models.find((m) => m.id !== t.lastModel && !this.brokenModels.has(m.id) && canRun(m, this.o.hardware, this.o.numCtx, this.o.allowOffload));
      if (other) t.forceModel = other.id;
    }
    const repeated = t.failures.includes(signature);
    t.failures.push(signature);
    // ошибка проверок: запомним (пройдёт — запишем решение в копилку) и сразу посмотрим, не решали ли такое раньше
    if (/^[3-6]:/.test(signature)) {
      t.lastCheckError = output;
      t.lastCheckSig = signature;
      this.checkBook(t, signature, output);
    }
    // ошибка проверок повторяется (или вторая неудача подряд) — перед следующей попыткой ищем справку, а не зовём человека
    const key = fixKey(signature);
    if (!/^(review:|format|agent:|conflict)/.test(signature) && (repeated || t.attempts >= 2) && !(t.lookedUp ?? []).includes(key)) t.needsLookup = true;

    // заплатки не попадают во фрагменты файла — дальше модель присылает файлы целиком (маленькие файлы это выдерживают)
    if (!t.wholeFile && /фрагмент не найден|фрагмент встречается/.test(output)) {
      t.wholeFile = true;
      this.journal.record({ type: 'self-help', taskId: t.id, what: 'заплатки не попадают в текст файла — следующая попытка пришлёт файл целиком' });
    }
    // бюджет попыток: модель, которая сходится (ошибок меньше, падает дальше), получает до двух попыток сверху
    if (t.attempts >= d.budget) {
      if (this.tryRethink(t)) return;
      this.toHuman(t, `исчерпан бюджет попыток (${d.budget}). Последняя ошибка: ${firstLine(output)}`);
      return;
    }
    void repeated;
    // модель сходится: тот же исполнитель с новым текстом ошибки, без нового действия лестницы (аналитика, дробления)
    if (d.stay) {
      this.journal.record({ type: 'escalate', taskId: t.id, step: t.ladderStep, what: 'прогресс — повтор без подъёма по лестнице', attempt: t.attempts });
      this.graph.setStatus(t.id, 'ready');
      return;
    }
    this.escalateTo(t, d.step);
    this.checkReplan();
  }

  private escalateTo(t: Task, step: number): void {
    const prevStep = t.ladderStep;
    t.ladderStep = step;
    this.journal.record({ type: 'escalate', taskId: t.id, step, what: '', attempt: t.attempts });
    switch (step) {
      case 1:
      case 2:
        this.graph.setStatus(t.id, 'ready');
        return;
      case 3:
        t.needsAnalysis = true;
        this.graph.setStatus(t.id, 'ready');
        return;
      case 4:
        // дробить имеет смысл только крупную задачу; маленькую правку с замороженным тестом
        // дробление превращает в бессмыслицу («напиши тест» к задаче «почини код») — сразу зовём старшего
        if (canSplit(t, this.graph.depth(t.id)) && this.splitBudget()) {
          t.needsSplit = true;
          this.graph.setStatus(t.id, 'ready');
          return;
        }
        return this.escalateTo(t, 5);
      case 5: {
        // «старший» уже работает над задачей — он и продолжает
        if (prevStep === 5 && t.forceModel && t.forceModel === t.lastModel) {
          this.graph.setStatus(t.id, 'ready');
          return;
        }
        const stronger = this.strongerModel(t);
        if (stronger) {
          t.forceModel = stronger.id;
          this.graph.setStatus(t.id, 'ready');
          return;
        }
        return this.escalateTo(t, 6);
      }
      default:
        if (this.tryRethink(t)) return;
        this.toHuman(t, `лестница эскалации пройдена. Последняя ошибка: ${firstLine(t.lastError ?? '')}`);
    }
  }

  /**
   * Последняя попытка без человека: планировщик смотрит на все ошибки и предлагает ДРУГОЙ путь
   * (другие файлы, другой способ, меньший шаг). Один раз на задачу.
   */
  private tryRethink(t: Task): boolean {
    if (t.rethought || this.graph.depth(t.id) >= ESCALATION.maxSplitDepth || !this.splitBudget()) return false;
    t.rethought = true;
    t.rethink = true;
    t.needsSplit = true;
    this.graph.setStatus(t.id, 'ready');
    this.journal.record({ type: 'self-help', taskId: t.id, what: 'обычные способы не помогли — прошу планировщика предложить другой подход, прежде чем звать человека' });
    return true;
  }

  /**
   * Тормоз дробления: частей уже вдвое больше, чем задач верхнего уровня (минимум 12), — дробление не помогает,
   * проблема глубже (план, окружение) — дальше без новых частей, к человеку с понятной причиной.
   */
  private splitBudget(): boolean {
    const all = this.graph.all();
    const parts = all.filter((x) => x.parent).length;
    const top = all.filter((x) => !x.parent && !/\.p\d+/.test(x.id)).length;
    const ok = parts < Math.max(12, top * 2);
    if (!ok && !this.splitBrakeNoted) {
      this.splitBrakeNoted = true;
      this.journal.record({ type: 'self-help', taskId: '—', what: `дробление остановлено: частей уже ${parts} при ${top} задачах — дальше дробить бессмысленно, похоже, мешает что-то общее (окружение, старые ошибки проекта, план)` });
    }
    return ok;
  }
  private splitBrakeNoted = false;

  /** «Позвать старшего»: скачанная модель сильнее той, что пробовала, — пусть и с выгрузкой в RAM. */
  private strongerModel(t: Task): CatalogModel | null {
    const current = this.installed.find((m) => m.id === t.lastModel);
    const curFit = current ? this.o.stats.successRate(current, t.role, t.size) : 0;
    const candidates = this.installed
      .filter((m) => m.id !== t.lastModel && m.id !== t.forceModel)
      .filter((m) => fitsMemory(m, this.o.hardware, this.o.numCtx, true))
      .map((m) => ({ m, fit: this.o.stats.successRate(m, t.role, t.size) }))
      .filter((x) => x.fit > curFit + 0.05)
      .sort((a, b) => b.fit - a.fit);
    return candidates[0]?.m ?? null;
  }

  private toHuman(t: Task, why: string): void {
    this.humanReasons.set(t.id, why);
    t.status = 'human'; // причина записана до события — доска сразу видит её
    this.graph.setStatus(t.id, 'human');
    this.journal.record({ type: 'human', taskId: t.id, why });
    this.promoteLeader(t, why);
  }

  private replanWarned = false;
  private checkReplan(): void {
    const all = this.graph.all();
    const deep = all.filter((t) => t.ladderStep >= 4).length;
    if (!this.replanWarned && all.length >= 3 && deep / all.length > ESCALATION.replanShare) {
      this.replanWarned = true;
      this.journal.record({ type: 'human', taskId: '—', why: 'больше трети задач дошли до дробления: похоже, проблема в плане. После прогона стоит перепланировать оставшееся.' });
    }
  }

  // ---------- уровень 8: полный набор тестов и поиск виновника ----------

  private async finalVerify(): Promise<void> {
    const cmd = this.map.commands.test;
    let commits = await this.ws.taskCommits(this.runBase);
    if (!cmd || commits.length === 0) return;

    // «Сначала тест», а код к нему не получился: тест правильный, но красный — это не поломка.
    // Убираем его из ветки сборки, чтобы она осталась зелёной, и честно пишем, почему.
    let orphaned = false;
    for (const t of this.graph.byStatus('done')) {
      if (t.type !== 'test') continue;
      const blocked = this.graph.all().filter((d) => d.dependsOn.includes(t.id) && d.status !== 'done');
      if (!blocked.length) continue;
      const own = commits.filter((c) => c.subject.split(':')[0] === t.id).reverse();
      for (const c of own) await this.ws.revertInIntegration(c.sha);
      orphaned = true;
      const ids = blocked.map((b) => b.id).join(', ');
      this.toHuman(t, `тест написан и принят, но код к нему (${ids}) не получился — тест убран из ветки, чтобы она оставалась рабочей; его текст есть в transcripts`);
    }
    if (orphaned) commits = await this.ws.taskCommits(this.runBase);
    const dir = await this.ws.integrationWorktree();
    try {
      this.commandsRun.push(cmd);
      const full = await runCommand(cmd, dir);
      this.journal.record({ type: 'full-suite', passed: full.code === 0, output: full.code === 0 ? undefined : full.output.slice(0, 2000) });
      if (full.code === 0) return;

      // был ли набор зелёным до прогона? Красный — сравниваем падения: новых нет — задачи ничего не сломали
      await git(dir, ['checkout', '-q', '--detach', this.runBase]);
      const base = await runCommand(cmd, dir);
      if (base.code !== 0) {
        const cmp = compareOutcomes({ code: full.code, output: full.output }, { code: base.code, output: base.output });
        if (cmp.preexisting) {
          this.journal.record({ type: 'self-help', taskId: '—', what: `полный набор тестов красный так же, как до прогона (${cmp.before} падений), — задачи нового не сломали; старые падения — дело проекта, не этого прогона` });
          return;
        }
        this.journal.record({ type: 'self-help', taskId: '—', what: `полный набор был красным и до прогона, но появились новые падения (${cmp.fresh.length}) — ищу, какая задача их внесла` });
      }
      // «хороший» коммит — без новых падений относительно исходного состояния
      const good = (r: CommandResult) => r.code === 0 || (base.code !== 0 && compareOutcomes({ code: r.code, output: r.output }, { code: base.code, output: base.output }).preexisting);
      const shas = commits.map((c) => c.sha);
      const culprit = await bisectFirstBad(shas, async (sha) => {
        await git(dir, ['checkout', '-q', '--detach', sha]);
        return good(await runCommand(cmd, dir));
      });
      const subject = commits.find((c) => c.sha === culprit)?.subject ?? '';
      const taskId = subject.split(':')[0];
      this.journal.record({ type: 'bisect', culprit, taskId });
      if (culprit) {
        await this.ws.revertInIntegration(culprit);
        const t = taskId ? this.graph.tasks.get(taskId) : undefined;
        if (t) this.toHuman(t, 'после слияния сломала общий набор тестов; её коммит откатан');
      }
    } finally {
      await this.ws.removeWorktree(dir);
    }
  }
}

/** Сохранённое состояние прогона (для «Продолжить»). */
export interface RunState {
  runId: string;
  goal: string;
  understanding?: string;
  base: string;
  target: string;
  tasks: Task[];
  humanReasons: [string, string][];
  installed: [string, string][];
  pools?: PoolMeta[];
  solutions?: [string, string][];
  decisions?: { list?: Decision[]; fixes?: import('./decisions.ts').FixRecipe[] };
}

export function readRunState(runDir: string): RunState | null {
  const f = path.join(runDir, 'state.json');
  try {
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as RunState) : null;
  } catch {
    return null;
  }
}

/** Запрос к модели оборвал «Стоп» человека. */
export class StopError extends Error {
  constructor() {
    super('Прогон остановлен человеком — запрос к модели оборван.');
  }
}

/** Ollama не смогла загрузить модель — отличаем от остальных ошибок, чтобы не ронять прогон. */
export class ModelLoadError extends Error {
  readonly model: string;
  readonly detail: string;
  constructor(model: string, detail: string) {
    super(
      /CUDA|0xc0000409/i.test(detail)
        ? `Модель ${model} не загрузилась ни на видеокарту, ни на процессор. Ollama не может работать с CUDA — перезапусти Ollama (трей → Quit → открыть снова); если повторяется — обнови драйвер NVIDIA и Ollama. Ошибка: ${detail}`
        : `Модель ${model} не загрузилась: ${detail}`,
    );
    this.model = model;
    this.detail = detail;
  }
}

/** Дробим только задачи, у которых есть что дробить. */
export function canSplit(t: Task, depth = TaskGraph.splitDepth(t.id)): boolean {
  if (depth >= ESCALATION.maxSplitDepth) return false;
  if (t.frozenFiles.length > 0) return false;
  if (t.type === 'test') return false; // тест на одну функцию дробить бессмысленно
  return t.size !== 'S' || t.files.length > 1;
}

/** Первая содержательная строка ошибки: заголовок «Ступень N (…):» и служебные строки пропускаем. */
export function firstLine(s: string): string {
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const i = lines.findIndex((l) => !/^Ступень \d+ \([^)]*\):?$/.test(l) && !/^(\[eval\]|at |Node\.js v|\^+$)/.test(l));
  const useful = i >= 0 ? lines[i]! : (lines[0] ?? '');
  // «Новые ошибки (…):» — это заголовок, сама ошибка на следующей строке
  if (i >= 0 && useful.endsWith(':') && lines[i + 1]) return `${useful} ${lines[i + 1]}`.slice(0, 320);
  return useful.slice(0, 200);
}

/** «Проверить …», «Убедиться …» — задача-проверка: возможно, менять ничего не нужно. */
export function isVerifyTask(t: Pick<Task, 'title'>): boolean {
  return /^\s*(проверить|проверь|убедиться|убедись|удостовериться|verify|check|ensure|confirm)(?=[\s,.:;!-]|$)/i.test(t.title);
}

/** Задача у человека только потому, что ждёт другую (не начата / не собрана) — её можно вернуть агентам сама собой. */
export function blockedReason(why: string | undefined): boolean {
  return !!why && /^не (начата|собрана)/.test(why);
}

const NOT_IDENT = new Set(['TypeScript', 'JavaScript', 'React', 'JSX', 'TSX', 'HTML', 'CSS', 'API', 'UI', 'URL', 'JSON', 'Next', 'Node', 'ESLint', 'Without', 'The', 'This', 'Missing', 'Import', 'Нужно', 'Без']);

/**
 * «Нет импорта X» / «X не определён» — проверяем по тексту файлов: X используется и импортирован (или объявлен)
 * во всех файлах, где используется, — причина неверна. Возвращает объяснение или null.
 */
export function importClaimFalse(reason: string, files: { file: string; text: string }[], typed: boolean): string | null {
  if (!/(импорт|import|не определ|not defined|undefined|не объявлен|cannot find name|не найден)/i.test(reason)) return null;
  const ids = new Set<string>();
  for (const m of reason.matchAll(/`([A-Za-z_$][\w$]*)(?:\.[\w$]+)*`/g)) ids.add(m[1]!);
  for (const m of reason.matchAll(/\b([A-Z][A-Za-z0-9_$]+)\b/g)) if (!NOT_IDENT.has(m[1]!) && !/^T\d/.test(m[1]!)) ids.add(m[1]!);
  let judged = 0;
  for (const id of ids) {
    const esc = id.replace(/\$/g, '\\$');
    const use = new RegExp(`\\b${esc}\\b`);
    const users = files.filter((f) => f.text.split('\n').some((l) => use.test(l) && !/^\s*import\b/.test(l)));
    if (!users.length) continue;
    const imported = new RegExp(`import\\s+(?:type\\s+)?[^;]*?\\b${esc}\\b[^;]*?from\\s+['"]|\\b(?:function|const|let|var|class|interface|type|enum)\\s+${esc}\\b|require\\([^)]*\\)[^\\n]*\\b${esc}\\b|\\b${esc}\\b[^\\n]*=\\s*require\\(`, 's');
    if (!users.every((f) => imported.test(f.text))) return null;
    judged++;
  }
  if (!judged) return null;
  return `импорт или объявление есть в файле${typed ? ', и проверка типов прошла' : ''}`;
}

/** «Другие страницы не изменены» в задаче-части: остальные файлы — не её работа. */
export function scopeClaimFalse(reason: string, t: Task): string | null {
  const claim = /(other|остальн|други[ехм]|ещё не|still use|not updated|не обновл|не изменен|не затронут|all (the )?(list )?pages|все (страниц|файл)|всех (страниц|файл)|only .{0,60}(updated|changed|modified)|только .{0,60}(обновл|измен|затронут|правк))/i;
  if (!claim.test(reason)) return null;
  const mine = new Set(t.files.flatMap((f) => [f, f.split('/').pop()!, f.split('/').pop()!.replace(/\.[^.]+$/, '')]));
  const mentioned = [...reason.matchAll(/[\w./-]+\.(?:tsx?|jsx?|vue|svelte|css|scss|py|go|rb|php|cs|java)\b|\b[a-z]+(?:-[a-z]+)*-(?:list|edit|view|page)s?\b/g)].map((m) => m[0]);
  const foreign = mentioned.filter((m) => !mine.has(m) && !mine.has(m.split('/').pop()!) && !t.files.some((f) => f.includes(m)));
  // упоминает чужие файлы или говорит «остальные/все страницы» — это требование к другим задачам
  if (foreign.length || /(other|остальн|други[ехм]|all (the )?(list )?pages|все (страниц|файл)|всех (страниц|файл))/i.test(reason)) {
    return t.similar ? 'остальные файлы программа сделает по образцу после слияния' : 'это не файлы этой задачи — их делают другие задачи';
  }
  return null;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 200);
}
