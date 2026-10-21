// Планировщик: модельный (цель обычными словами) и детерминированный («почини падающие тесты»).

import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { AGENT, TIER_LIMITS } from './config.ts';
import { loadSkill, thinkFor } from './agent.ts';
import { PLAN_SCHEMA, validatePlan, type PlanCheck } from './plan.ts';
import { detectStacks } from './stacks.ts';
import { runCommand } from './checks.ts';
import type { RepoMap } from './repomap.ts';
import { jsonObjectsIn } from './tools/shim.ts';
import type { ChatMessage, Runtime } from './runtime/types.ts';
import type { Plan, PlannedTask, Task, Tier } from './types.ts';

/**
 * «Почини тесты», «тесты падают», «красные тесты» — это режим fix-tests, даже если написано небрежно.
 * Только для коротких просьб без другой работы («почини тесты и добавь кнопку» — уже не он).
 */
export function isFixTestsGoal(goal: string): boolean {
  const g = goal.trim().toLowerCase().replace(/ё/g, 'е');
  if (g === 'fix-tests') return true;
  if (g.length > 80 || !/тест|test/.test(g)) return false;
  if (/добав|созда|напиш|измени|поменя|нов|покрой|допиш|кнопк|страниц|цвет/.test(g)) return false;
  return /почин|исправ|пада|упал|красн|сломал|не прох|позелен|зелен|fix/.test(g);
}

/** Детерминированный план без модели: каждый падающий тестовый файл — отдельная задача. */
export async function planFixTests(repo: string, map: RepoMap): Promise<Plan> {
  if (!map.commands.testFiles && !map.commands.test) {
    throw new Error('Не нашёл, как запускать тесты в проекте. Добавь скрипт test в package.json или pytest.');
  }
  const tasks: PlannedTask[] = [];
  let n = 1;
  const candidates = map.commands.testFiles ? map.testFiles : ['(весь набор)'];
  for (const testFile of candidates) {
    const cmd = map.commands.testFiles ? map.commands.testFiles.replace('{files}', `"${testFile}"`) : map.commands.test!;
    const r = await runCommand(cmd, repo);
    if (r.code === 0) continue;
    const sources = map.commands.testFiles ? importedSources(repo, testFile) : [];
    tasks.push({
      id: `T${n++}`,
      type: 'edit',
      title: `Починить ${testFile}`,
      brief: `Тест ${testFile} падает. Найди причину в коде (не в тесте) и исправь её. Вывод теста:\n${r.output.slice(0, 2500)}`,
      dependsOn: [],
      files: sources.length ? sources : [],
      accept: { tests: map.commands.testFiles ? [testFile] : [], commands: map.commands.testFiles ? [] : [cmd] },
      size: 'S',
      testFirst: false,
      // тест не трогаем: чинить нужно код
      freeze: map.commands.testFiles ? [testFile] : [],
    });
  }
  return { goal: 'Починить падающие тесты', tasks };
}

/** Локальные файлы, которые импортирует тест: это кандидаты на правку. */
export function importedSources(repo: string, testFile: string): string[] {
  const abs = path.join(repo, testFile);
  if (!existsSync(abs)) return [];
  const text = readFileSync(abs, 'utf8');
  const out = new Set<string>();
  const re = /(?:from\s+|require\(\s*|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  const isFile = (f: string) => existsSync(f) && statSync(f).isFile();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const base = path.join(path.dirname(abs), m[1]!);
    const candidates = [base, base.replace(/\.js$/, '.ts'), `${base}.js`, `${base}.ts`, `${base}.mjs`, path.join(base, 'index.js'), path.join(base, 'index.ts')];
    const found = candidates.find(isFile);
    if (found) out.add(path.relative(repo, found).split(path.sep).join('/'));
  }
  return [...out].filter((f) => f !== testFile);
}

/** Планировщик-модель: строгая JSON-схема + проверка кодом, до двух переделок. */
export async function planWithModel(opts: {
  runtime: Runtime;
  modelTag: string;
  goal: string;
  repo: string;
  repoMapText: string;
  tier: Tier;
  numCtx: number;
  thinking?: 'toggle' | 'levels';
  /** Ход генерации для живой строки в окне. */
  onProgress?: (p: import('./runtime/types.ts').ChatProgress) => void;
  /** Модель на процессоре: рассуждения короче, иначе план пишется десятки минут. */
  lowThink?: boolean;
  /** Команды проверки проекта: без тестов план подстраивается (см. adaptToProject). */
  commands?: import('./repomap.ts').ProjectCommands;
  /** Найденные поиском места в коде, относящиеся к цели. */
  contextText?: string;
  /** Проверенные рецепты для такого типа задач. */
  recipesText?: string;
}): Promise<PlanCheck> {
  const limits = TIER_LIMITS[opts.tier];
  const ask = [
    '## Карта проекта',
    opts.repoMapText,
    '## Цель (как написал человек — может быть небрежно, с опечатками и ругательствами; пойми смысл)',
    opts.goal,
    ...(opts.contextText ? ['## Где это, скорее всего, в коде (поиск по словам цели)', opts.contextText] : []),
    ...(opts.recipesText ? ['## Рецепт для такой задачи (проверенный способ — следуй ему)', opts.recipesText] : []),
    '## Ограничения',
    `- В одной задаче-правке не больше ${limits.maxFiles} файл(ов) и примерно ${limits.maxChangedLines} изменённых строк.`,
    ...partsNote(opts.repo),
    ...(opts.commands && !opts.commands.test && !opts.commands.testFiles
      ? [
          '- В проекте НЕТ запуска тестов: не планируй тесты, задачи type=test и testFirst; не пиши в brief «добавь тест». accept.tests и accept.commands оставь пустыми — программа сама подставит доступную проверку.',
        ]
      : [
          '- У каждой задачи type=edit или test обязателен критерий: тестовый файл в accept.tests или команда в accept.commands.',
          '- Для новой функции ставь testFirst=true и указывай в accept.tests новый тестовый файл.',
        ]),
    '- Файлы, которых ещё нет, перечисли в newFiles.',
    '- id задач: T1, T2, …',
  ].join('\n\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: loadSkill('planner') },
    { role: 'user', content: ask },
  ];

  let last: PlanCheck | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await opts.runtime.chat({
      model: opts.modelTag,
      messages,
      format: PLAN_SCHEMA as unknown as Record<string, unknown>,
      temperature: AGENT.temperaturePlan,
      numCtx: opts.numCtx,
      think: opts.lowThink ? (opts.thinking === 'levels' ? 'low' : opts.thinking ? false : undefined) : thinkFor('planner', opts.thinking),
      onProgress: opts.onProgress,
      maxTokens: AGENT.maxTokens.planner,
    });
    const parsed = jsonObjectsIn(r.message.content).find((o) => o && typeof o === 'object' && Array.isArray((o as { tasks?: unknown }).tasks)) as
      | { tasks: PlannedTask[]; understanding?: string }
      | undefined;
    if (!parsed) {
      messages.push({ role: 'assistant', content: r.message.content }, { role: 'user', content: 'Ответ — не JSON. Верни план строго по схеме.' });
      continue;
    }
    const plan: Plan = { goal: opts.goal, tasks: parsed.tasks.map(fillDefaults), understanding: typeof parsed.understanding === 'string' ? parsed.understanding.trim() : undefined };
    last = validatePlan(plan, opts.repo, opts.tier, opts.commands);
    if (last.ok) return last;
    messages.push(
      { role: 'assistant', content: r.message.content },
      { role: 'user', content: `План не прошёл проверку. Исправь:\n${last.errors.map((e) => `- ${e}`).join('\n')}` },
    );
  }
  return last ?? { ok: false, errors: ['Планировщик не вернул разборчивый план.'], warnings: [], plan: { goal: opts.goal, tasks: [] } };
}

/** Ступень 4: дробление задачи на 2–3 поменьше. */
export async function splitWithModel(opts: {
  runtime: Runtime;
  modelTag: string;
  task: Task;
  repo: string;
  repoMapText: string;
  tier: Tier;
  numCtx: number;
  thinking?: 'toggle' | 'levels';
  /** Ход генерации для живой строки в окне. */
  onProgress?: (p: import('./runtime/types.ts').ChatProgress) => void;
  /** Модель на процессоре: рассуждения короче, иначе план пишется десятки минут. */
  lowThink?: boolean;
  /** Не дробить, а предложить другой путь: прежний не сработал совсем. */
  rethink?: boolean;
  /** Разбить попросил человек: подзадачи поменьше, можно и другим путём. */
  byHuman?: boolean;
  /** Команды проверки проекта — без них в проекте без тестов любой план «без критерия». */
  commands?: import('./repomap.ts').ProjectCommands;
  /** Уже принятые решения (матрёшка: что решено у предков и соседей) — части должны на них опираться. */
  decisionsText?: string;
}): Promise<PlannedTask[] | null> {
  const t = opts.task;
  const tried = [...new Set(t.failures)].slice(-4).map((f) => `- ${f.slice(0, 200)}`).join('\n');
  const goal = [
    `Задача ${t.id} «${t.title}» не получилась за ${t.attempts} попыток.`,
    `Бриф: ${t.brief}`,
    `Файлы: ${t.files.join(', ')}`,
    `Критерий: тесты ${t.accept.tests.join(', ') || '—'}, команды ${t.accept.commands.join(', ') || '—'}`,
    ...(tried ? [`На чём падали попытки:\n${tried}`] : []),
    `Последняя ошибка: ${(t.lastError ?? '').slice(0, 1500)}`,
    ...(t.reference ? [`Справка по ошибке (типы библиотек и интернет):\n${t.reference.slice(0, 2500)}`] : []),
    ...(opts.decisionsText ? [`Уже принятые решения (части не должны им противоречить и не должны переделывать сделанное):\n${opts.decisionsText}`] : []),
    'Каждая часть — атом: один файл (или файл и его стили), одно действие. В каждой части заполни steps: 3–7 конкретных шагов (какой файл открыть, что именно на что заменить или что добавить, как проверить себя). Части пишут в brief, что решила предыдущая часть, если от неё зависят.',
    opts.byHuman
      ? 'Человек попросил разбить эту задачу на 2–4 подзадачи поменьше и попробовать снова без него. Каждая подзадача — маленький шаг с одним-двумя файлами и проверяемым результатом; учти, на чём падали попытки, и если путь был неверный — выбери другой. Последняя подзадача должна давать исходный результат.'
      : opts.rethink
      ? 'Прежний подход не сработал. Предложи ДРУГОЙ путь к той же цели: 1–3 задачи. Подумай, в каком файле на самом деле нужна правка (может, не в том, что указан), нужен ли другой способ (переписать небольшой файл целиком, добавить недостающий импорт или файл, исправить причину ошибки, а не следствие). Не повторяй то, что уже падало. Последняя задача должна давать исходный результат.'
      : 'Разбей её на 2–3 задачи поменьше, каждая со своим проверяемым критерием. Последняя подзадача должна включать исходный критерий.',
  ].join('\n');
  const check = await planWithModel({ ...opts, goal });
  if (!check.ok || check.plan.tasks.length < (opts.rethink ? 1 : 2)) return null;
  // переименовываем: T3 → T3.1, T3.2 …; внутренние зависимости тоже
  const rename = new Map(check.plan.tasks.map((p, i) => [p.id, `${t.id}.${i + 1}`]));
  return check.plan.tasks.map((p) => ({
    ...p,
    id: rename.get(p.id)!,
    dependsOn: p.dependsOn.map((d) => rename.get(d) ?? d).filter((d) => [...rename.values()].includes(d)),
  }));
}

function fillDefaults(p: Partial<PlannedTask>): PlannedTask {
  return {
    id: String(p.id ?? ''),
    type: p.type ?? 'edit',
    title: String(p.title ?? ''),
    brief: String(p.brief ?? p.title ?? ''),
    dependsOn: p.dependsOn ?? [],
    files: (p.files ?? []).map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')),
    newFiles: (p.newFiles ?? []).map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')),
    accept: { tests: p.accept?.tests ?? [], commands: p.accept?.commands ?? [] },
    size: p.size ?? 'M',
    testFirst: p.testFirst ?? false,
    ...(typeof p.similar === 'string' && p.similar.includes('*') ? { similar: p.similar } : {}),
    ...(Array.isArray(p.install) && p.install.length ? { install: p.install.map(String) } : {}),
    ...(Array.isArray(p.steps) && p.steps.length ? { steps: p.steps.map((x) => String(x).trim()).filter(Boolean).slice(0, 10).map((x) => x.slice(0, 400)) } : {}),
    ...(typeof p.stage === 'string' && p.stage.trim() ? { stage: p.stage.trim().slice(0, 80) } : {}),
    ...(Array.isArray(p.inputs) && p.inputs.length ? { inputs: p.inputs.map((f) => String(f).replace(/\\/g, '/').replace(/^\.\//, '')) } : {}),
  };
}

/** Проект из частей: где тесты есть, а где нет, и куда ставятся пакеты — чтобы план не требовал невозможного. */
function partsNote(repo: string): string[] {
  const stacks = existsSync(repo) ? detectStacks(repo) : [];
  if (stacks.length < 2 && !stacks.some((s) => s.dir)) return [];
  const lines = stacks.map((s) => `${s.dir || 'корень'} (${s.name}): ${s.test || s.testFiles ? `тесты — ${s.test ?? s.testFiles}` : 'тестов нет'}`);
  return [
    `- Проект из частей: ${lines.join('; ')}. Каждая задача проверяется командами своей части.`,
    '- Для задач в части без тестов не планируй тесты и testFirst, accept.tests оставь пустым — программа проверит синтаксис, типы и признаки готовности. Тестовые файлы клади внутрь своей части (web/tests/…), не в корень.',
    '- Пакеты npm (install) ставятся в package.json части, где лежат файлы задачи.',
  ];
}
