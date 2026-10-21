// Строгий конвейер с циклом эпох по модели — как цикл событий в движке JS.
//
// Смена модели в видеокарте — самое дорогое действие (8–20 с, при сбоящей видеокарте — риск сбоя),
// а одна задача без этого требовала двух смен: код одной моделью, ревью другой.
// Поэтому работа идёт эпохами:
//
//   МАКРОЗАДАЧА — загрузить модель. Выбирается модель, у которой больше всего работы (сумма весов задач,
//                 которые она может сделать), при равенстве — та, что грузится быстрее.
//   МИКРОЗАДАЧИ — всё, что загруженная модель может сделать, пока она в памяти, по порядку:
//     1. ревью, которое она может сделать (не автор правки; маленькую проверенную программой правку — может и автор);
//     2. начатое: переделка после проверок или ревью, разбор аналитиком, дробление;
//     3. новые задачи по очереди (seq), пока в работе меньше WIP (3);
//     4. ещё независимые задачи сверх WIP (до EPOCH_WIP), если иначе пришлось бы менять модель.
//   Между микрозадачами процессорная дорожка доделывает проверки и слияния. Если у модели работы нет, но идут
//   проверки, — ждём их (секунды), а не меняем модель: после проверок работа для неё может появиться.
//   Только когда очередь загруженной модели пуста и ждать нечего — смена модели (следующая макрозадача).
//
// Порядок задач прежний: у каждой место в очереди (seq), части задачи — на её месте, файлы пула — за образцом,
// начатое доделывается раньше нового.

import { modelsFor, scorePair, type DispatchContext, type Pick, type WorkItem } from './dispatcher.ts';
import { epochRate, ett, SCHED, worthInterrupting } from './engine/scheduler.ts';
import type { CatalogModel, Task } from './types.ts';

export const CONVEYOR = {
  /** Сколько задач одновременно в работе в обычном режиме. */
  wip: 3,
  /** Сколько задач можно держать в работе, чтобы не менять модель (независимые задачи берёт загруженная модель). */
  epochWip: 6,
  /** Загруженная модель берёт шаг, если её оценка не хуже этой доли от лучшей модели (с учётом цены смены). */
  affinity: 0.6,
  /** Ревью, от которого ждут столько задач, идёт сразу после начатой работы текущей модели. */
  urgentBlocks: 2,
};

/** Сравнение мест в очереди: «0003» < «0003.01» < «0003.p01» < «0004». */
export function seqCmp(a: string | undefined, b: string | undefined): number {
  const x = a ?? '';
  const y = b ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Задача уже начата: были попытки, есть рабочая копия, идёт стадия или назначена ступень лестницы. */
export function started(t: Task): boolean {
  return t.attempts > 0 || !!t.workdir || t.status === 'running' || t.status === 'checking' || t.status === 'review' || !!t.needsSplit || !!t.needsAnalysis || !!t.forceModel;
}

/** Сколько задач сейчас в работе (начаты и ещё не влиты и не у человека). */
export function inProgress(all: Task[]): number {
  return all.filter((t) => !t.children?.length && ['ready', 'running', 'checking', 'review'].includes(t.status) && started(t)).length;
}

/**
 * Нужна ли этой правке «вторая пара глаз» — другая модель. Нужна для образцов (их решение повторится везде),
 * правок по шаблону, тестов, задач покрупнее и правок в нескольких файлах. Маленькую правку одного файла,
 * которую уже проверила программа (синтаксис, типы, признаки готовности), может посмотреть и та же модель.
 */
export function needsCrossReview(t: Task, isLeader = false): boolean {
  // общий файл стилей рядом с правкой (планировщик добавляет его к задачам «про внешний вид») — не повод менять модель
  const code = t.files.filter((f) => !/\.(css|scss|sass|less|md|mdx|html|svg|txt)$/i.test(f));
  return isLeader || !!t.similar || t.type === 'test' || t.size !== 'S' || code.length > 1;
}

export interface ConveyorOptions {
  wip?: number;
  epochWip?: number;
  /** Сколько не начатых задач ждут эту (прямо или через пул). */
  blocks?: (t: Task) => number;
  /** Назначенная лестницей «старшая» модель задачи (ступень 5). */
  forced?: (t: Task) => CatalogModel | null;
  /** Задача — образец пула (её ревью важнее). */
  isLeader?: (t: Task) => boolean;
  /** Идут проверки на процессорной дорожке (после них может появиться работа для загруженной модели). */
  checking?: boolean;
}

export interface ConveyorPick {
  pick: Pick | null;
  /** Работа есть, но сейчас её брать нельзя (всё начатое на проверках) — подождать процессорную дорожку. */
  wait: boolean;
}

function candidatesFor(item: WorkItem, ctx: DispatchContext): CatalogModel[] {
  let candidates = modelsFor(item, ctx.team, ctx.shaky).filter((m) => ctx.fits(m));
  if (candidates.length === 0 && item.kind === 'review') candidates = ctx.team.models.filter((m) => ctx.fits(m));
  return candidates;
}

/** Может ли модель m отревьюить задачу сейчас. */
function canReview(m: CatalogModel, item: WorkItem, ctx: DispatchContext, opts: ConveyorOptions): boolean {
  if (!ctx.fits(m)) return false;
  if (ctx.shaky || ctx.team.models.length === 1) return true;
  if (item.task.doneBy !== m.id) return true;
  // автор правки: только маленькая проверенная правка — или если другой модели нет в памяти совсем
  if (!needsCrossReview(item.task, opts.isLeader?.(item.task))) return true;
  return !ctx.team.models.some((x) => x.id !== m.id && ctx.fits(x));
}

/**
 * Модель годится для шага работы: не назначен другой «старший», и её ожидаемое время до успеха (с долей цены загрузки)
 * не хуже лучшей модели. Загруженной — допуск на половину цены возврата к ней (уйти и вернуться — две смены).
 */
function fitsWork(m: CatalogModel, item: WorkItem, ctx: DispatchContext, opts: ConveyorOptions, batch: (m: CatalogModel) => number): Pick | null {
  if (!ctx.fits(m)) return null;
  const forced = opts.forced?.(item.task);
  if (forced && item.kind === 'work' && item.role === item.task.role) return forced.id === m.id ? scorePair(item, m, ctx) : null;
  const mine = ett(item, m, ctx, batch(m));
  let best = { m, t: mine };
  for (const c of candidatesFor(item, ctx)) {
    const t = ett(item, c, ctx, batch(c));
    if (t < best.t) best = { m: c, t };
  }
  const tolerance = m.id === ctx.loadedModelId ? SCHED.returnShare * ctx.stats.swapSeconds(m.id) : 0;
  if (best.m.id !== m.id && mine > best.t + tolerance) return null;
  const pick = scorePair(item, m, ctx);
  return { ...pick, reason: `${pick.reason}; до успеха ≈${Math.round(mine)} с${best.m.id !== m.id ? ` (у ${best.m.ollamaTag} ≈${Math.round(best.t)} с)` : ''}` };
}

export function conveyorPick(items: WorkItem[], all: Task[], ctx: DispatchContext, opts: ConveyorOptions = {}): ConveyorPick {
  const wip = opts.wip ?? CONVEYOR.wip;
  const epochWip = Math.max(wip, opts.epochWip ?? CONVEYOR.epochWip);
  const bySeq = (a: WorkItem, b: WorkItem) => seqCmp(a.task.seq, b.task.seq);
  const reviews = items.filter((i) => i.kind === 'review').sort(bySeq);
  const works = items.filter((i) => i.kind === 'work').sort((a, b) => Number(started(b.task)) - Number(started(a.task)) || bySeq(a, b));
  const begun = works.filter((i) => started(i.task));
  const fresh = works.filter((i) => !started(i.task));
  const now = inProgress(all);
  const blocks = opts.blocks ?? (() => 0);
  const why = (p: Pick, text: string): Pick => ({ ...p, reason: `${text}; ${p.reason}` });

  // сколько шагов модель могла бы сделать за одну загрузку — между ними делится цена смены
  const eligible = new Map<string, number>();
  const batch = (m: CatalogModel) => {
    let n = eligible.get(m.id);
    if (n === undefined) {
      n = items.filter((i) => (i.kind === 'review' ? canReview(m, i, ctx, opts) : candidatesFor(i, ctx).some((c) => c.id === m.id))).length;
      eligible.set(m.id, n);
    }
    return n;
  };

  /** Очередь микрозадач модели m в порядке выполнения. */
  const queueOf = (m: CatalogModel, limit: number) => {
    const out: { item: WorkItem; pick: Pick; text: string }[] = [];
    for (const r of reviews) if (canReview(m, r, ctx, opts)) out.push({ item: r, pick: scorePair(r, m, ctx), text: r.task.doneBy === m.id ? 'ревью той же моделью: маленькая правка, программа её уже проверила — смена модели дороже' : 'ревью, пока нужная модель в памяти' });
    for (const w of begun) {
      const p = fitsWork(m, w, ctx, opts, batch);
      if (p) out.push({ item: w, pick: p, text: opts.forced?.(w.task) ? 'позвали старшего' : 'доделываю начатую' });
    }
    let room = limit - now;
    for (const w of fresh) {
      if (room <= 0) break;
      const p = fitsWork(m, w, ctx, opts, batch);
      if (!p) continue;
      out.push({ item: w, pick: p, text: limit > wip ? `пока ${m.ollamaTag} в памяти — беру ещё независимую задачу вместо смены модели (в работе ${now} из ${limit})` : `следующая в очереди (в работе ${now} из ${limit})` });
      room--;
    }
    return out;
  };

  const loaded = ctx.team.models.find((m) => m.id === ctx.loadedModelId && ctx.fits(m));
  // срочное ревью: его ждут задачи, загруженная модель его сделать не может, и прервать эпоху дешевле, чем заставить их ждать
  const loadedLeft = loaded ? queueOf(loaded, wip).reduce((s, x) => s + ctx.stats.expectedSeconds(loaded.id, x.item.role), 0) : 0;
  const urgent = reviews.find((r) => {
    if (blocks(r.task) < CONVEYOR.urgentBlocks || (loaded && canReview(loaded, r, ctx, opts))) return false;
    if (!loaded || loadedLeft === 0) return true;
    const to = ctx.team.models.find((m) => m.id !== loaded.id && ctx.fits(m) && canReview(m, r, ctx, opts));
    return !!to && worthInterrupting(blocks(r.task), loadedLeft, to, loaded, ctx);
  });

  // ---------- микрозадачи загруженной модели ----------
  if (loaded) {
    const q = queueOf(loaded, wip);
    // ревью образца, которого ждут другие задачи, — сразу после начатого (оно разблокирует пул)
    const urgentOther = urgent;
    const first = urgentOther ? q.find((x) => x.item.kind === 'review' || started(x.item.task)) : q[0];
    if (first) return { pick: why(first.pick, `эпоха ${loaded.ollamaTag}: ${first.text}`), wait: false };
    if (!urgentOther) {
      // сверх обычного WIP — независимые задачи, лишь бы не менять модель
      const extra = queueOf(loaded, epochWip)[0];
      if (extra) return { pick: why(extra.pick, `эпоха ${loaded.ollamaTag}: ${extra.text}`), wait: false };
      // работы для неё нет, но идут проверки — после них она может понадобиться снова: ждём секунды, а не меняем модель
      if (opts.checking && items.length) return { pick: null, wait: true };
    }
  }

  // ---------- макрозадача: какую модель грузить ----------
  let bestModel: { m: CatalogModel; q: ReturnType<typeof queueOf>; load: number } | null = null;
  for (const m of ctx.team.models) {
    if (!ctx.fits(m) || m.id === loaded?.id) continue;
    // ревью образца, которого ждут другие, решает, какую модель грузить
    if (urgent && !canReview(m, urgent, ctx, opts)) continue;
    const q = queueOf(m, epochWip);
    if (!q.length) continue;
    // производительность эпохи: полезная работа (вес, ждущие задачи, шанс успеха) в секунду, включая загрузку
    const load = epochRate(q.map((x) => x.item), m, ctx, (i) => blocks(i.task));
    if (!bestModel || load > bestModel.load) bestModel = { m, q, load };
  }
  if (bestModel) {
    const total = bestModel.q.length;
    // внутри эпохи — тот же порядок: ревью, начатое, новое по очереди (но новое — в пределах обычного WIP, если есть другое)
    const head = (urgent && bestModel.q.find((x) => x.item === urgent)) || bestModel.q.find((x) => x.item.kind === 'review' || started(x.item.task)) || bestModel.q[0]!;
    return { pick: why(head.pick, `смена модели на ${bestModel.m.ollamaTag}: у неё ${total} шаг(ов) работы — сделает их подряд; ${head.text}`), wait: false };
  }
  // нет ни одной модели с работой: всё начатое на проверках — подождать
  return { pick: null, wait: works.length > 0 || reviews.length > 0 || !!opts.checking };
}
