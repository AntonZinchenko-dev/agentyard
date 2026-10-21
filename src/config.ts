// Все настройки алгоритма в одном месте.
// Цифры — стартовые значения из документа «Алгоритм управления агентами».

import type { Role, Tier, TaskType } from './types.ts';

/** Веса ролей при выборе бригады (сумма = 1). */
export const ROLE_WEIGHTS: Record<Role, number> = {
  coder: 0.35,
  planner: 0.2,
  reviewer: 0.15,
  tester: 0.15,
  analyst: 0.1,
  scout: 0.025,
  reporter: 0.025,
};

/** Какая роль делает задачу какого типа. */
export const ROLE_FOR_TYPE: Record<TaskType, Role> = {
  analyze: 'analyst',
  test: 'tester',
  edit: 'coder',
  review: 'reviewer',
};

/** Лимиты задач по тирам железа. */
export const TIER_LIMITS: Record<Tier, { maxFiles: number; maxChangedLines: number; maxSteps: number; maxTeam: number }> = {
  T0: { maxFiles: 1, maxChangedLines: 40, maxSteps: 10, maxTeam: 1 },
  T1: { maxFiles: 1, maxChangedLines: 40, maxSteps: 10, maxTeam: 1 },
  T2: { maxFiles: 2, maxChangedLines: 80, maxSteps: 15, maxTeam: 2 },
  T3: { maxFiles: 3, maxChangedLines: 150, maxSteps: 20, maxTeam: 2 },
  T4: { maxFiles: 3, maxChangedLines: 150, maxSteps: 20, maxTeam: 3 },
};

export const DISPATCH = {
  /** Бонус уже загруженной модели (гистерезис). */
  hysteresis: 1.3,
  /** За сколько секунд ожидания оценка задачи удваивается (старение). */
  agingSeconds: 600,
  /** Множитель веса переделки почти готовой задачи. */
  reworkBoost: 1.5,
};

export const TEAM = {
  /** Штраф μ за каждую лишнюю модель в бригаде (цена смен модели). */
  extraModelPenalty: 0.02,
  /** Бонус за «второе мнение»: ревьюер — другая модель, чем кодер. */
  reviewerDiversityBonus: 0.03,
  /** Минимальный контекст для кодера, токенов. */
  minCoderContext: 16_384,
};

/**
 * Несколько вариантов правки на повторе (как в Agentless: выборка кандидатов + проверка программой).
 * После своей ошибки модель даёт ещё варианты с разной «смелостью» — без смены модели, — программа проверяет их по очереди
 * и берёт первый прошедший. Маленькая модель часто попадает со второго-третьего ответа, а не с пятой попытки по лестнице.
 */
export const SAMPLING = {
  candidates: 3,
  temperatures: [0.15, 0.55, 0.85],
};

export const ESCALATION = {
  maxAttempts: 5,
  maxSplitDepth: 2,
  /** Доля задач на ступени 4+, после которой предлагаем перепланировать. */
  replanShare: 1 / 3,
  /** Сколько раз после всех задач проверяем «цель достигнута?» и доделываем недостающее. */
  goalCheckRounds: 2,
};

export const AGENT = {
  /** Предел длины одного ответа модели по ролям, токенов. */
  maxTokens: { coder: 4096, tester: 4096, reviewer: 3072, analyst: 2048, planner: 6144, scout: 2048, reporter: 2048 } as Record<string, number>,
  /** Прямой режим: исполнитель отвечает одним JSON по схеме, если всё нужное уже показано. */
  directMode: true,
  /** Роли, которым разрешено «думать» перед ответом. Остальным рассуждения выключаем. */
  thinkingRoles: ['planner'] as string[],
  /** Сколько символов вывода инструмента отдаём модели (≈2K токенов). */
  toolOutputChars: 8_000,
  temperatureCode: 0.15,
  temperaturePlan: 0.3,
  /** Контекст по умолчанию, токенов. Ollama без явного значения даёт мало. */
  defaultContext: 16_384,
};

export const CHECKS = {
  commandTimeoutMs: 5 * 60_000,
  /** Файлы, которые агентам трогать нельзя. */
  forbidden: [
    /(^|\/)package-lock\.json$/,
    /(^|\/)pnpm-lock\.yaml$/,
    /(^|\/)yarn\.lock$/,
    /(^|\/)\.github\//,
    /(^|\/)\.git\//,
  ],
  /** Полный набор тестов — после каждых N слитых задач. */
  fullSuiteEvery: 5,
};

export const STATS = {
  /** Сколько «виртуальных» попыток весит оценка каталога. */
  priorWeight: 2,
  /** Успехи помним «окном» примерно из стольких последних задач: старые неудачи (например, из прогонов со сломанными проверками) не держат модель внизу вечно. */
  successWindow: 20,
  /** Вес нового замера в скользящем среднем. */
  emaAlpha: 0.2,
};

export const CPU_LANE = {
  /** Доля ядер под параллельные проверки. */
  coreShare: 0.5,
};

export const BATCH = {
  /** «Первая деталь партии» имеет смысл, только если после неё в партии остаётся столько задач. */
  firstArticleMinRemaining: 2,
};
