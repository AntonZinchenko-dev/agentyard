// Цена работы с учётом смен моделей.
//
// Видеокарта держит одну модель. Смена — 7–20 секунд (gpt-oss → qwen 17 с, обратно 7 с), на сбоящей
// видеокарте — ещё и риск. Поэтому решения «какой модели дать шаг» и «когда менять модель» считаются
// в одних единицах — секундах до успеха:
//
//   ett(m, шаг) = смена(m) / n  +  τ(m) / p(m)  +  (1 − p(m)) · штраф
//
//   смена / n — цену загрузки делят все n шагов, которые модель сделает за эпоху (пачка дешевле одиночки);
//   τ / p     — ожидаемое время до успеха при повторах (геометрическое распределение);
//   штраф     — что стоит неудача сверх повтора: проверки, ступень лестницы, риск дойти до человека.
//
// Загруженная модель оставляет шаг себе, если её ett не хуже лучшей + половина цены возврата к ней
// (уйти и вернуться — две смены). Слабая модель (p = 0.16) больше не держит задачу только потому,
// что уже в памяти: 6 с / 0.16 + 0.84 · 60 = 88 с против 17 + 10 / 0.6 + 0.4 · 60 = 58 с у сильной.
//
// Срочность — по цене задержки: ревью, которого ждут k задач, стоит прервать эпоху, если
//   k · (сколько ещё работать загруженной модели) > смена туда + смена обратно.
// Выбор следующей модели — по производительности эпохи: Σ вес · p / (смена + Σ τ).

import type { DispatchContext, WorkItem } from '../dispatcher.ts';
import type { CatalogModel } from '../types.ts';
import { SHAKY_SWAP_PENALTY } from '../dispatcher.ts';

export const SCHED = {
  /** Сколько секунд «стоит» неудача сверх самого повтора. */
  failPenalty: 60,
  /** Нижняя граница вероятности успеха (иначе деление на ноль). */
  minP: 0.05,
  /** Какая доля цены возврата к загруженной модели считается при сравнении. */
  returnShare: 0.5,
};

export function swapCost(m: CatalogModel, ctx: DispatchContext): number {
  if (m.id === ctx.loadedModelId) return 0;
  return ctx.stats.swapSeconds(m.id) + (ctx.shaky ? SHAKY_SWAP_PENALTY : 0);
}

/** Вероятность успеха шага у модели (с учётом прошлых попыток задачи: каждая неудача немного снижает её). */
export function successOf(item: WorkItem, m: CatalogModel, ctx: DispatchContext): number {
  const p = ctx.stats.successRate(m, item.role, item.task.size);
  // эта же модель уже не справилась с задачей — её шанс на ней ниже
  const own = item.task.lastModel === m.id && item.kind === 'work' ? Math.pow(0.8, Math.min(3, item.task.attempts)) : 1;
  return Math.max(SCHED.minP, Math.min(0.98, p * own));
}

/** Ожидаемые секунды до успеха шага у модели; batch — сколько шагов модель сделает за одну загрузку. */
export function ett(item: WorkItem, m: CatalogModel, ctx: DispatchContext, batch = 1): number {
  const p = successOf(item, m, ctx);
  const tau = ctx.stats.expectedSeconds(m.id, item.role);
  return swapCost(m, ctx) / Math.max(1, batch) + tau / p + (1 - p) * SCHED.failPenalty;
}

/** Секунды работы, которые есть у модели (без смены). */
export function workSeconds(items: WorkItem[], m: CatalogModel, ctx: DispatchContext): number {
  return items.reduce((s, it) => s + ctx.stats.expectedSeconds(m.id, it.role), 0);
}

/** Производительность эпохи модели: полезная работа в секунду с учётом загрузки. */
export function epochRate(items: WorkItem[], m: CatalogModel, ctx: DispatchContext, blocks: (i: WorkItem) => number = () => 0): number {
  if (!items.length) return 0;
  const value = items.reduce((s, it) => s + (it.task.weight + blocks(it)) * successOf(it, m, ctx), 0);
  return value / (swapCost(m, ctx) + workSeconds(items, m, ctx));
}

/** Стоит ли прервать эпоху загруженной модели ради шага другой модели, которого ждут blocked задач. */
export function worthInterrupting(blocked: number, loadedLeft: number, to: CatalogModel, loaded: CatalogModel, ctx: DispatchContext): boolean {
  if (blocked <= 0) return false;
  const there = swapCost(to, ctx);
  const back = ctx.stats.swapSeconds(loaded.id) + (ctx.shaky ? SHAKY_SWAP_PENALTY : 0);
  return blocked * loadedLeft > there + back;
}
