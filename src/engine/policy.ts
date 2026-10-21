// Что делать после неудачи — по её классу и по истории попыток, а не только по счётчику.
//
//   окружение (нет пакета)      → программа ставит пакет и перепроверяет; попытка не тратится
//   окружение (сеть, утилита)   → одна перепроверка, потом человек с точной причиной (не модель!)
//   сбой модели / Ollama        → повтор без траты попытки; второй сбой — другая модель
//   формат                      → напоминание формата; второй раз у той же модели — другая модель
//   прогресс (ошибок меньше,    → та же ступень: модель сходится, не мешаем; бюджет +2 попытки
//     или упала дальше)
//   та же правка второй раз     → модель зациклилась: сразу аналитик, дальше — выше по лестнице
//   та же ошибка второй раз     → ступенью выше
//   иначе                       → повтор с текстом ошибки

import type { FailureClass, Triage } from './triage.ts';

export interface AttemptLog {
  sig: string;
  cls: FailureClass;
  /** Ступень проверок, на которой упали (0 — не проверки). */
  stage: number;
  errors: number;
  /** Отпечаток правки (одинаковые правки — одинаковый отпечаток). */
  patch?: string;
  model?: string;
}

export interface PolicyInput {
  /** Прежние неудачи задачи, от старых к новым. */
  history: AttemptLog[];
  now: AttemptLog;
  triage: Triage;
  ladderStep: number;
  /** Засчитанные попытки до этой неудачи. */
  attempts: number;
  maxAttempts: number;
  /** Можно ли ставить пакеты. */
  canInstall: boolean;
  /** Подсказка «повтор формата» от исполнителя. */
  hintStep?: number;
}

export type Decision =
  | { action: 'install'; packages: string[]; why: string }
  | { action: 'retry'; step: number; count: boolean; otherModel?: boolean; budget: number; why: string; stay?: boolean }
  | { action: 'human'; why: string };

/** Ступень проверок по подписи «5:…». */
export function stageOf(sig: string): number {
  const m = /^(\d):/.exec(sig);
  return m ? Number(m[1]) : 0;
}

export function decide(p: PolicyInput): Decision {
  const { history, now, triage: tri } = p;
  const prev = history.at(-1);
  const step0 = Math.max(p.ladderStep, 2);

  if (tri.cls === 'environment' && tri.env) {
    if (tri.env.kind === 'missing-package' && tri.env.packages?.length) {
      if (p.canInstall && !history.some((h) => h.cls === 'environment' && h.sig === now.sig)) {
        return { action: 'install', packages: tri.env.packages, why: `${tri.env.detail} — ставит программа, попытка не тратится` };
      }
      if (!p.canInstall) return { action: 'human', why: `${tri.env.detail}. Разреши установку пакетов в настройках прогона или поставь сам: npm install ${tri.env.packages.join(' ')}` };
    }
    // сеть, утилита, go.sum — модель тут не поможет; один повтор (сеть могла моргнуть), потом человек с точной причиной
    if (!history.some((h) => h.cls === 'environment')) return { action: 'retry', step: p.ladderStep || 2, stay: true, count: false, budget: p.maxAttempts, why: `${tri.env.detail} — повторю проверку, попытка не тратится` };
    return { action: 'human', why: `мешает окружение, а не код: ${tri.env.detail}` };
  }

  if (tri.cls === 'infra') {
    const infra = history.filter((h) => h.cls === 'infra').length;
    if (infra >= 3) return { action: 'human', why: 'модель раз за разом не отвечает — проверь Ollama' };
    return { action: 'retry', step: p.ladderStep || 2, stay: true, count: false, otherModel: infra >= 1, budget: p.maxAttempts, why: infra ? 'модель снова не ответила — беру другую' : 'модель не ответила — повтор, попытка не тратится' };
  }

  if (tri.cls === 'format') {
    const sameModelFormat = prev?.cls === 'format' && prev.model === now.model;
    if (sameModelFormat) return { action: 'retry', step: Math.max(p.ladderStep, 1), count: true, otherModel: true, budget: p.maxAttempts, why: 'та же модель второй раз ответила не по формату — беру другую' };
    return { action: 'retry', step: p.ladderStep <= 1 ? 1 : p.ladderStep, count: true, budget: p.maxAttempts, why: 'напоминание формата ответа' };
  }

  // модель повторила ту же правку, что уже падала, — она зациклилась
  if (now.patch && history.some((h) => h.patch === now.patch)) {
    const step = p.ladderStep < 3 ? 3 : p.ladderStep + 1;
    return { action: 'retry', step, count: true, budget: p.maxAttempts, why: 'та же правка второй раз — нужен другой взгляд' };
  }

  // прогресс: упала дальше по проверкам или ошибок стало меньше — модель сходится, ступень не меняем
  const progress = !!prev && prev.cls !== 'review' && (now.stage > prev.stage || (now.stage === prev.stage && now.stage > 0 && now.errors < prev.errors && now.sig !== prev.sig));
  const progressRuns = (() => {
    let n = 0;
    const all = [...history, now];
    for (let i = all.length - 1; i > 0; i--) {
      const a = all[i]!;
      const b = all[i - 1]!;
      if (a.stage > b.stage || (a.stage === b.stage && a.stage > 0 && a.errors < b.errors && a.sig !== b.sig)) n++;
      else break;
    }
    return n;
  })();
  const budget = p.maxAttempts + Math.min(2, progressRuns);
  if (progress && progressRuns <= 3) return { action: 'retry', step: step0, stay: true, count: true, budget, why: now.stage > prev!.stage ? 'прогресс: упала на более поздней проверке' : `прогресс: ошибок меньше (${prev!.errors} → ${now.errors})` };

  const repeated = history.some((h) => h.sig === now.sig);
  const step = p.hintStep === 1 && !repeated && p.ladderStep <= 1 ? 1 : repeated ? step0 + 1 : step0;
  return { action: 'retry', step, count: true, budget, why: repeated ? 'та же ошибка снова — ступенью выше' : 'повтор с текстом ошибки' };
}
