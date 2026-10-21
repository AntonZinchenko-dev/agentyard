// Уровень 3. Диспетчер: что делать следующим.
//
//   score(t, m) = w_t · p(m, t) / (τ(m, t) + s(m_cur → m)) · h(m) · a(t)
//
// w — вес по критическому пути, p — вероятность успеха, τ — ожидаемое время,
// s — смена модели, h — гистерезис (бонус загруженной), a — старение.
// Это правило Смита из теории расписаний плюс поправка на смену модели.

import { DISPATCH } from './config.ts';
import type { CatalogModel, Role, Task, Team } from './types.ts';
import type { Stats } from './stats.ts';

/** Единица работы для видеокарты: задача + роль (правка, тест, ревью и т.д.). */
export interface WorkItem {
  task: Task;
  role: Role;
  kind: 'work' | 'review';
}

export interface Pick {
  item: WorkItem;
  model: CatalogModel;
  score: number;
  reason: string;
  parts?: { weight: number; p: number; seconds: number; swap: number; hysteresis: number; aging: number };
}

export interface DispatchContext {
  team: Team;
  stats: Stats;
  loadedModelId: string | null;
  now: number;
  /** Помещается ли модель в свободную память прямо сейчас. */
  fits: (m: CatalogModel) => boolean;
  /**
   * Видеокарта в этом прогоне уже сбоила при загрузке модели: каждая смена — риск нового сбоя и ухода на процессор.
   * Тогда держимся загруженной модели: ревью делает она же, смена стоит очень дорого.
   */
  shaky?: boolean;
}

/** Сколько секунд «стоит» риск смены модели на нестабильной видеокарте. */
export const SHAKY_SWAP_PENALTY = 900;

/** Кандидаты на роль: модели бригады; для ревью — по возможности не та, что делала правку. */
export function modelsFor(item: WorkItem, team: Team, shaky = false): CatalogModel[] {
  if (!shaky && item.kind === 'review' && team.models.length > 1 && item.task.doneBy) {
    const others = team.models.filter((m) => m.id !== item.task.doneBy);
    if (others.length) return others;
  }
  // для экономии смен моделей рассматриваем всю бригаду, а не только «назначенную» на роль модель
  return team.models;
}

export function chooseNext(items: WorkItem[], ctx: DispatchContext): Pick | null {
  if (items.length === 0) return null;

  const forced = forcedRule(items, ctx);
  if (forced) return forced;

  let best: Pick | null = null;
  for (const item of items) {
    let candidates = modelsFor(item, ctx.team, ctx.shaky).filter((m) => ctx.fits(m));
    // «другая модель» для ревью недоступна (не влезла или не загрузилась) — ревьюит та же, лучше чем никто
    if (candidates.length === 0 && item.kind === 'review') candidates = ctx.team.models.filter((m) => ctx.fits(m));
    for (const model of candidates) {
      const pick = scorePair(item, model, ctx);
      if (!best || pick.score > best.score) best = pick;
    }
  }
  return best;
}

export function scorePair(item: WorkItem, model: CatalogModel, ctx: DispatchContext): Pick {
  const t = item.task;
  const loaded = model.id === ctx.loadedModelId;
  const weight = t.weight * (t.attempts > 0 ? DISPATCH.reworkBoost : 1);
  const p = ctx.stats.successRate(model, item.role, t.size);
  const seconds = ctx.stats.expectedSeconds(model.id, item.role);
  const swap = loaded ? 0 : ctx.stats.swapSeconds(model.id) + (ctx.shaky ? SHAKY_SWAP_PENALTY : 0);
  const hysteresis = loaded ? DISPATCH.hysteresis : 1;
  const waited = Math.max(0, ctx.now - t.readySince) / 1000;
  const aging = 1 + waited / DISPATCH.agingSeconds;
  const score = ((weight * p) / (seconds + swap)) * hysteresis * aging;
  return {
    item,
    model,
    score,
    reason: `оценка ${score.toFixed(4)}: вес ${weight.toFixed(1)} × успех ${p.toFixed(2)} ÷ (${seconds.toFixed(0)} с + смена ${swap.toFixed(0)} с) × гистерезис ${hysteresis} × старение ${aging.toFixed(2)}`,
    parts: { weight, p, seconds, swap, hysteresis, aging },
  };
}

/** Жёсткие правила поверх формулы. */
function forcedRule(items: WorkItem[], ctx: DispatchContext): Pick | null {
  // Первая деталь партии: её ревью идёт сразу, даже ценой смены модели.
  const first = ctx.shaky ? undefined : items.find((i) => i.kind === 'review' && i.task.firstOfBatch);
  if (first) {
    const candidates = modelsFor(first, ctx.team).filter(ctx.fits);
    if (candidates.length) {
      const best = candidates
        .map((m) => scorePair(first, m, ctx))
        .sort((a, b) => b.score - a.score)[0]!;
      return { ...best, reason: `первая деталь партии идёт на ревью сразу; ${best.reason}` };
    }
  }
  return null;
}
