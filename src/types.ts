// Общие типы ядра AgentYard.
// Всё, что ходит между модулями, описано здесь — как «словарь» проекта.

export type Role = 'scout' | 'planner' | 'analyst' | 'coder' | 'tester' | 'reviewer' | 'reporter';

/** Тип задачи из плана. От типа зависит роль, которая её делает. */
export type TaskType = 'analyze' | 'test' | 'edit' | 'review';

export type TaskSize = 'S' | 'M' | 'L';

export type TaskStatus =
  | 'waiting'   // ждёт предшественников
  | 'ready'     // можно брать в работу
  | 'running'   // модель работает над задачей
  | 'checking'  // идут проверки на процессорной дорожке
  | 'review'    // ждёт ревью моделью
  | 'done'      // принята и влита в ветку сборки
  | 'human';    // нужен человек

export interface Acceptance {
  /** Тесты, которые должны пройти (пути файлов внутри репозитория). */
  tests: string[];
  /** Дополнительные команды, которые должны завершиться с кодом 0. */
  commands: string[];
}

/** Задача в том виде, в каком её выдаёт планировщик. */
export interface PlannedTask {
  id: string;
  type: TaskType;
  title: string;
  /** Что именно сделать — бриф простыми словами. */
  brief: string;
  dependsOn: string[];
  files: string[];
  /** Файлы, которых ещё нет и которые задача создаёт. */
  newFiles?: string[];
  accept: Acceptance;
  size: TaskSize;
  /** Режим «сначала тест»: тест пишется отдельной задачей и замораживается. */
  testFirst?: boolean;
  /** Файлы, которые этой задаче менять запрещено (например, тест, который надо починить кодом). */
  freeze?: string[];
  /**
   * Правка по образцу: шаблон пути со звёздочками вместо имени сущности (например, src/pages/ЗВЁЗДОЧКА/ui/ЗВЁЗДОЧКАPage.tsx). Модель правит первый файл из files,
   * программа повторяет правку во всех файлах шаблона.
   */
  similar?: string;
  /** Пакеты npm, которые нужно поставить до работы над задачей (с разрешения человека). */
  install?: string[];
  /** Подробные шаги для исполнителя: что открыть, что на что заменить, как проверить себя. */
  steps?: string[];
  /** Признаки готовности, которые проверит программа: чего в файле не должно остаться и что должно появиться. */
  doneWhen?: DoneCheck[];
  /** Матрёшка: задача — часть более крупной (её родитель собирается из частей). */
  parent?: string;
  /** Пул однотипных задач с одним решением (id пула = id задачи-образца, с которой он начался). */
  pool?: string;
  /** Решение уже принято в этой задаче — исполнитель повторяет его (образец показывается в задаче). */
  solutionFrom?: string;
  /** Этап плана: шаг цели, к которому относится задача («Подключить кит», «Таблицы», «Шапка»). */
  stage?: string;
  /** Исходные материалы задачи не про код: документы и данные, которые надо прочитать (их текст программа покажет исполнителю). */
  inputs?: string[];
}

/** Машинный признак готовности файла. */
export interface DoneCheck {
  file: string;
  /** Этого в файле быть не должно (старые теги, классы, импорты). */
  lacks?: string[];
  /** Это в файле должно быть (импорт, новый компонент). */
  has?: string[];
}

export interface Plan {
  goal: string;
  tasks: PlannedTask[];
  /** Как планировщик понял цель — человеческими словами, для проверки перед запуском. */
  understanding?: string;
}

/** Задача во время прогона: план + состояние. */
export interface Task extends PlannedTask {
  role: Role;
  status: TaskStatus;
  /** Вес = 1 + число всех задач, которые от неё зависят. */
  weight: number;
  attempts: number;
  ladderStep: number;
  failures: string[];
  /** Когда задача стала готовой (мс), для «старения». */
  readySince: number;
  /** Файлы, которые кодеру менять нельзя (замороженные тесты). */
  frozenFiles: string[];
  /** Последняя ошибка — уходит в контекст следующей попытки. */
  lastError?: string;
  /** Последняя заплатка — тоже для контекста переделки. */
  lastPatch?: Patch[];
  /** Первая задача партии — её сразу ревьюят. */
  firstOfBatch?: boolean;
  /** Модель, которая делала правку (ревьюер должен быть другим, если можно). */
  doneBy?: string;
  /** Папка рабочей копии задачи (git worktree). */
  workdir?: string;
  branch?: string;
  /** Ступень 4: задачу надо раздробить планировщиком. */
  needsSplit?: boolean;
  /** Ступень «другой подход»: прежний путь не сработал — планировщик предлагает иной (1–3 задачи). */
  rethink?: boolean;
  /** Разбить попросил человек кнопкой: подзадачи 2–4, можно другим путём. */
  splitByHuman?: boolean;
  /** Другой подход уже пробовали — второй раз не повторяем. */
  rethought?: boolean;
  /** Заплатки не попадали во фрагменты — модель присылает изменённые файлы целиком. */
  wholeFile?: boolean;
  /** Ступень 3: перед следующей попыткой задачу заново разбирает аналитик. */
  needsAnalysis?: boolean;
  /** Ступень 5: «позвать старшего» — конкретная сильная модель. */
  forceModel?: string;
  /** Файлы, которых не было, когда задача началась: их можно пересоздавать целиком. */
  createdHere?: string[];
  /** Модель, которая сделала первую (или последнюю) попытку — для статистики. */
  lastModel?: string;
  /** Место в конвейере: задачи идут строго по этому ключу (части задачи встают на её место). */
  seq?: string;
  /** Матрёшка: задача разбита на части и собирается, когда все они сделаны. */
  children?: string[];
  /** Сколько раз сборка из частей не прошла критерий задачи. */
  assembleTries?: number;
  /** Ошибка повторяется — перед следующей попыткой программа ищет справку (типы библиотек, интернет). */
  needsLookup?: boolean;
  /** По каким ошибкам справку уже искали (подписи без путей и чисел). */
  lookedUp?: string[];
  /** Найденная справка — уходит исполнителю. */
  reference?: string;
  /** Что изменила последняя правка (для разбора неудачи: свои файлы или чужие). */
  lastChanged?: string[];
  /** История неудач: класс, ступень проверок, число ошибок, отпечаток правки — по ней выбирается следующий шаг. */
  attemptLog?: import('./engine/policy.ts').AttemptLog[];
  /** Отпечаток последней правки. */
  lastPatchHash?: string;
  /** Подсказка человека: решение или кусок кода, вставленный в панели задачи. Идёт исполнителю в каждой следующей попытке. */
  humanHint?: string;
  /** Сколько раз подряд исполнитель ответил «менять нечего». */
  noops?: number;
  /** Последняя ошибка проверок (синтаксис, линтер, типы, тесты) — если задача потом пройдёт, это попадёт в копилку решений. */
  lastCheckError?: string;
  lastCheckSig?: string;
  /** Заметка исполнителя к последней сданной правке. */
  lastNote?: string;
  /** По каким ошибкам уже смотрели копилку решений. */
  bookChecked?: string[];
}

export interface Patch {
  file: string;
  search: string;
  replace: string;
  /** Заменить каждое вхождение search (одинаковые теги и классы по всему файлу), а не ровно одно. */
  all?: boolean;
}

/** Запись из каталога моделей. */
export interface CatalogModel {
  id: string;
  ollamaTag: string;
  paramsTotalB: number;
  paramsActiveB: number;
  memoryGbQ4: number;
  license: string;
  toolCalling: boolean;
  contextMax: number;
  /** Пригодность к ролям от 0 до 1 — стартовая оценка. */
  roles: Partial<Record<Role, number>>;
  /** Модель прошлого поколения: работает, но для агентов слабовата. */
  legacy?: boolean;
  /** Умеет рассуждать перед ответом: toggle — вкл/выкл, levels — уровни low/medium/high. */
  thinking?: 'toggle' | 'levels';
}

export interface Hardware {
  gpuName: string | null;
  vramTotalGb: number;
  vramFreeGb: number;
  ramTotalGb: number;
  ramFreeGb: number;
  cpuCores: number;
  unifiedMemory: boolean;
  tier: Tier;
}

export type Tier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4';

export interface Team {
  models: CatalogModel[];
  /** Какая модель какую роль берёт по умолчанию. */
  byRole: Record<Role, CatalogModel>;
  score: number;
}

export interface CheckResult {
  passed: boolean;
  /** Номер ступени, на которой остановились (1..6). */
  stage: number;
  stageName: string;
  output: string;
  /** Короткая «подпись» ошибки для лестницы эскалации. */
  signature: string;
  durationMs: number;
  /** Что программа учла по ходу: падения, которые были до прогона, пропущенные проверки. */
  notes?: string[];
  /** Падение целиком было и до прогона — не вина задачи (для статистики и лестницы). */
  preexisting?: boolean;
}

/** Задача в том виде, в каком её видит интерфейс. */
export interface TaskView {
  id: string;
  type: TaskType;
  role: Role;
  title: string;
  brief: string;
  status: TaskStatus;
  dependsOn: string[];
  files: string[];
  tests: string[];
  commands: string[];
  frozen: string[];
  attempts: number;
  ladderStep: number;
  lastError?: string;
  doneBy?: string;
  lastModel?: string;
  humanWhy?: string;
  install?: string[];
  steps?: string[];
  doneWhen?: DoneCheck[];
  /** Справка, которую нашла программа (типы библиотек, интернет) — уходит исполнителю. */
  reference?: string;
  stage?: string;
  inputs?: string[];
  humanHint?: string;
  /** На чём споткнулись: ступень, конкретные ошибки с местами, что пробовали, что нужно от человека. */
  stumble?: import('./engine/stumble.ts').Stumble;
  parent?: string;
  children?: string[];
  pool?: string;
  poolLeader?: boolean;
  solutionFrom?: string;
  seq?: string;
}

/** Живые события конвейера для интерфейса. */
export type LiveEvent =
  | { kind: 'phase'; phase: 'team' | 'map' | 'planning' | 'approval' | 'running' | 'verifying' | 'stopping' | 'finished'; team?: string[]; detail?: string }
  | { kind: 'journal'; at: string; event: unknown; line: string }
  | { kind: 'tasks'; tasks: TaskView[]; active: { taskId: string; role: Role; model: string } | null }
  /** Что происходит прямо сейчас: gpu — работа модели, cpu — проверки. text null — дорожка свободна. */
  | { kind: 'activity'; lane: string; taskId?: string; role?: string; model?: string; text: string | null; since: string };
