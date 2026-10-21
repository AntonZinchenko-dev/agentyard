// Уровень 1. Состав бригады.
// Перебираем все наборы моделей до k штук и берём набор с наибольшей суммой:
//   Σ_r w_r · max_{m∈T} fit(m, r)  −  μ · (|T| − 1)  +  бонус, если ревьюер ≠ кодер
// Ограничение: если моделей ≥ 2, ревьюер — не та же модель, что кодер.

import { ROLE_WEIGHTS, TEAM, TIER_LIMITS } from './config.ts';
import type { CatalogModel, Hardware, Role, Team } from './types.ts';
import type { Stats } from './stats.ts';

const ROLES = Object.keys(ROLE_WEIGHTS) as Role[];

/** Оценка памяти под контекст: грубо 1,5 ГБ на 16K токенов. */
export function kvCacheGb(contextTokens: number): number {
  return 1.5 * (contextTokens / 16_384);
}

/** Поместится ли модель в видеопамять вместе с контекстом и запасом 1 ГБ. */
export function fitsMemory(m: CatalogModel, hw: Hardware, contextTokens: number, allowOffload = false): boolean {
  const need = m.memoryGbQ4 + kvCacheGb(contextTokens) + 1;
  // без видеокарты модель работает на процессоре из оперативки (тир T0) — медленно, но работает
  if (hw.vramTotalGb < 1 && !hw.unifiedMemory) return need <= hw.ramTotalGb * 0.6;
  if (need <= hw.vramTotalGb) return true;
  // частичная выгрузка в RAM: медленнее, но работает (особенно для MoE)
  return allowOffload && need <= hw.vramTotalGb + hw.ramTotalGb * 0.5;
}

/** Модель «смесь экспертов» (MoE): на каждое слово работает малая часть весов. */
export function isMoE(m: CatalogModel): boolean {
  return m.paramsActiveB > 0 && m.paramsActiveB <= m.paramsTotalB / 3;
}

/**
 * Можно ли запускать модель. MoE-моделям частичная выгрузка в оперативку разрешена всегда:
 * активных весов мало, поэтому замедление умеренное, а выигрыш в качестве большой.
 */
export function canRun(m: CatalogModel, hw: Hardware, contextTokens: number, allowOffload = false): boolean {
  return fitsMemory(m, hw, contextTokens, allowOffload || isMoE(m));
}

export interface TeamOptions {
  allowOffload?: boolean;
  maxTeam?: number;
}

export function selectTeam(
  candidates: CatalogModel[],
  hw: Hardware,
  stats: Stats,
  opts: TeamOptions = {},
): Team {
  const usable = candidates.filter(
    (m) => m.toolCalling && canRun(m, hw, TEAM.minCoderContext, opts.allowOffload ?? false),
  );
  if (usable.length === 0) {
    throw new Error(
      'Нет ни одной скачанной модели, которая помещается в память. Скачай модель поменьше (команда models покажет варианты).',
    );
  }

  const k = Math.min(opts.maxTeam ?? TIER_LIMITS[hw.tier].maxTeam, usable.length);
  let best: Team | null = null;

  for (const set of subsets(usable, k)) {
    const team = scoreTeam(set, stats);
    if (!best || team.score > best.score) best = team;
  }
  return best!;
}

export function scoreTeam(set: CatalogModel[], stats: Stats): Team {
  const fit = (m: CatalogModel, r: Role) => stats.successRate(m, r, 'M');
  const byRole = {} as Record<Role, CatalogModel>;

  for (const r of ROLES) {
    byRole[r] = argmax(set, (m) => fit(m, r));
  }
  // разнообразие: ревьюер — другая модель, если есть из кого выбирать
  if (set.length >= 2) {
    const others = set.filter((m) => m.id !== byRole.coder.id);
    byRole.reviewer = argmax(others, (m) => fit(m, 'reviewer'));
  }

  let score = 0;
  for (const r of ROLES) score += ROLE_WEIGHTS[r] * fit(byRole[r], r);
  score -= TEAM.extraModelPenalty * (set.length - 1);
  if (byRole.reviewer.id !== byRole.coder.id) score += TEAM.reviewerDiversityBonus;

  return { models: set, byRole, score };
}

function argmax<T>(items: T[], f: (x: T) => number): T {
  let best: T = items[0]!;
  let bestV = -Infinity;
  for (const it of items) {
    const v = f(it);
    if (v > bestV) {
      bestV = v;
      best = it;
    }
  }
  return best;
}

/** Все непустые подмножества размером до k. Моделей мало — перебор мгновенный. */
export function* subsets<T>(items: T[], k: number): Generator<T[]> {
  const n = items.length;
  function* rec(start: number, acc: T[]): Generator<T[]> {
    if (acc.length > 0) yield acc.slice();
    if (acc.length === k) return;
    for (let i = start; i < n; i++) {
      acc.push(items[i]!);
      yield* rec(i + 1, acc);
      acc.pop();
    }
  }
  yield* rec(0, []);
}
