// Уровень 2. План: проверка кодом (без модели) и нормализация.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { TIER_LIMITS } from './config.ts';
import type { ProjectCommands } from './repomap.ts';
import { listFiles } from './tools/fs.ts';
import { matchFiles, templateRegex } from './replicate.ts';
import { goalTerms } from './context.ts';
import { validSpec } from './install.ts';
import type { Plan, PlannedTask, Tier } from './types.ts';
import { detectStacks, type Stack } from './stacks.ts';
import { isMulti, nodeDirFor, scopedCommands, testCommandsFor } from './engine/workspace.ts';
import { READABLE } from './engine/extract.ts';

/** Задача не про код: читает документы и пишет результат (out/…, .md, .csv, .json), а не правит программу. */
export function isDocTask(t: { inputs?: string[]; files: string[]; newFiles?: string[] }): boolean {
  if (t.inputs?.length) return true;
  const all = [...t.files, ...(t.newFiles ?? [])];
  return all.length > 0 && all.every((f) => /^out\//.test(f));
}

export interface PlanCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
  plan: Plan;
}

/** JSON-схема ответа планировщика — её получает модель, рантайм не даёт отклониться. */
export const PLAN_SCHEMA = {
  type: 'object',
  required: ['understanding', 'tasks'],
  properties: {
    understanding: { type: 'string' },
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'type', 'title', 'brief', 'dependsOn', 'files', 'accept', 'size'],
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: ['analyze', 'test', 'edit'] },
          title: { type: 'string' },
          brief: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          files: { type: 'array', items: { type: 'string' } },
          newFiles: { type: 'array', items: { type: 'string' } },
          accept: {
            type: 'object',
            required: ['tests', 'commands'],
            properties: {
              tests: { type: 'array', items: { type: 'string' } },
              commands: { type: 'array', items: { type: 'string' } },
            },
          },
          size: { type: 'string', enum: ['S', 'M', 'L'] },
          testFirst: { type: 'boolean' },
          similar: { type: 'string' },
          install: { type: 'array', items: { type: 'string' } },
          steps: { type: 'array', items: { type: 'string' } },
          stage: { type: 'string' },
          inputs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

/**
 * Разворачивает режим «сначала тест»: перед правкой появляется задача тестировщика,
 * а правка начинает от неё зависеть. Тестовые файлы для правки заморожены (см. graph.ts).
 */
export function expandTestFirst(plan: Plan): Plan {
  const out: PlannedTask[] = [];
  const ids = new Set(plan.tasks.map((t) => t.id));
  for (const t of plan.tasks) {
    // уже развёрнуто (план проверяют дважды: планировщик и конвейер) — не дублируем
    if (t.type === 'edit' && t.testFirst && t.accept.tests.length > 0 && !ids.has(`${t.id}-test`)) {
      const testId = `${t.id}-test`;
      out.push({
        id: testId,
        type: 'test',
        title: `Тест: ${t.title}`,
        brief: `Напиши тест, который проверяет новое поведение: ${t.brief}. Тест должен падать на текущем коде.`,
        dependsOn: [...t.dependsOn],
        files: [...t.accept.tests],
        // тест пишется с нуля этой задачей — все его файлы новые (существование проверит validatePlan)
        newFiles: [...t.accept.tests],
        accept: { tests: [...t.accept.tests], commands: [] },
        size: 'S',
      });
      out.push({ ...t, dependsOn: [...t.dependsOn, testId] });
    } else {
      out.push(t);
    }
  }
  return { ...plan, tasks: out };
}

/**
 * Правка, которая идёт после задачи-теста, проверяется ИМЕННО этим тестом.
 * Планировщик иногда ставит критерием самодельную команду вроде `node -e "require(...)"`,
 * которая не совпадает со стилем проекта и сама по себе ломается. Программа это выправляет:
 * тест предшественника становится критерием (и замораживается), разовые `node -e` убираются.
 */
export function linkTestTasks(plan: Plan, warnings: string[] = []): Plan {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const ancestors = (t: PlannedTask): PlannedTask[] => {
    const out: PlannedTask[] = [];
    const seen = new Set<string>();
    const stack = [...t.dependsOn];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const a = byId.get(id);
      if (!a) continue;
      out.push(a);
      stack.push(...a.dependsOn);
    }
    return out;
  };
  for (const t of plan.tasks) {
    if (t.type !== 'edit') continue;
    const upstreamTests = ancestors(t)
      .filter((a) => a.type === 'test')
      .flatMap((a) => (a.accept.tests.length ? a.accept.tests : a.files));
    const added = upstreamTests.filter((f) => !t.accept.tests.includes(f));
    if (added.length) {
      t.accept.tests.push(...added);
      t.freeze = [...new Set([...(t.freeze ?? []), ...added])];
      warnings.push(`${t.id}: критерий готовности — тест ${added.join(', ')} из предыдущей задачи (менять его нельзя).`);
    }
    if (t.accept.tests.length) {
      const adhoc = t.accept.commands.filter((c) => /^\s*node\s+(-e|--eval|-p|--print)\b/.test(c));
      if (adhoc.length) {
        t.accept.commands = t.accept.commands.filter((c) => !adhoc.includes(c));
        warnings.push(`${t.id}: убрал разовую команду-проверку (${adhoc.length} шт.) — есть настоящий тест.`);
      }
    }
  }
  return plan;
}

/**
 * План под возможности проекта. Нет запуска тестов — задачи-тесты бессмысленны (их нечем запустить,
 * «красный» тест нельзя отличить от сломанного): убираем их, критерием правки становится проверка типов.
 */
export function adaptToProject(plan: Plan, commands: ProjectCommands, warnings: string[] = [], stacks?: Stack[]): Plan {
  // проект из частей: тесты задачи запускает раннер её части. У web/ без раннера тесты не запустить,
  // даже если у backend/ есть go test (прогон 20261020144005: тест .tsx «проверялся» go test бэкенда)
  if (isMulti(stacks)) {
    const unrunnable = (files: string[]) => testCommandsFor(files, stacks, commands).unrunnable;
    const dropped = new Set(plan.tasks.filter((t) => t.type === 'test' && unrunnable(t.accept.tests.length ? t.accept.tests : t.files).length > 0).map((t) => t.id));
    const droppedTests = new Set(plan.tasks.filter((t) => dropped.has(t.id)).flatMap((t) => [...t.accept.tests, ...t.files]));
    const tasks: PlannedTask[] = [];
    const cut: string[] = [];
    for (const t of plan.tasks) {
      if (dropped.has(t.id)) continue;
      const bad = new Set([...unrunnable(t.accept.tests), ...t.accept.tests.filter((f) => droppedTests.has(f))]);
      if (!bad.size && !t.dependsOn.some((d) => dropped.has(d))) {
        tasks.push(t);
        continue;
      }
      if (bad.size) cut.push(t.id);
      const next: PlannedTask = {
        ...t,
        testFirst: bad.size ? false : t.testFirst,
        dependsOn: t.dependsOn.filter((d) => !dropped.has(d)),
        accept: { tests: t.accept.tests.filter((f) => !bad.has(f)), commands: [...t.accept.commands] },
        freeze: (t.freeze ?? []).filter((f) => !bad.has(f)),
        files: t.files.filter((f) => !bad.has(f) || !(t.newFiles ?? []).includes(f)),
        ...(t.newFiles ? { newFiles: t.newFiles.filter((f) => !bad.has(f)) } : {}),
      };
      if (bad.size && !t.brief.includes('Тестов не писать')) next.brief = `${t.brief}\n\nТестов не писать: в этой части проекта нет запуска тестов.`;
      tasks.push(next);
    }
    if (dropped.size || cut.length) warnings.push(`Тесты, которые нечем запустить в их части проекта, убраны${dropped.size ? ` (задачи-тесты ${[...dropped].join(', ')})` : ''}${cut.length ? `; критерий без тестов у ${cut.join(', ')}` : ''}: проверка — синтаксис, типы, признаки готовности и ревью.`);
    return { ...plan, tasks };
  }
  const canRunTests = !!(commands.test || commands.testFiles);
  if (canRunTests) return plan;
  const dropped = new Set(plan.tasks.filter((t) => t.type === 'test').map((t) => t.id));
  if (dropped.size) warnings.push(`В проекте нет запуска тестов — убрал задачи-тесты: ${[...dropped].join(', ')}.`);
  const tasks: PlannedTask[] = [];
  for (const t of plan.tasks) {
    if (dropped.has(t.id)) continue;
    const tests = t.accept.tests;
    const next: PlannedTask = {
      ...t,
      testFirst: false,
      dependsOn: t.dependsOn.filter((d) => !dropped.has(d)),
      accept: { tests: [], commands: [...t.accept.commands] },
      freeze: (t.freeze ?? []).filter((f) => !tests.includes(f)),
      files: t.files.filter((f) => !tests.includes(f) || !(t.newFiles ?? []).includes(f)),
    };
    if ((tests.length || /тест|test/i.test(t.brief)) && !t.brief.includes('Тестов не писать')) next.brief = `${t.brief}\n\nТестов не писать: в проекте нет запуска тестов.`;
    if (t.type === 'edit' && next.accept.commands.length === 0 && commands.typecheck) {
      // проверка типов и так идёт ступенью 5 каскада (с учётом ошибок, бывших до прогона) — отдельной командой не дублируем
      warnings.push(`${t.id}: критерий готовности — проверка типов; тестов в проекте нет.`);
    }
    tasks.push(next);
  }
  return { ...plan, tasks };
}

/** Файл-обёртка: только import/export, без разметки (app/(generated)/addresses/page.tsx — реэкспорт страницы). */
export function isWrapperFile(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !/^\s*(\/\/|\/\*|\*|'use client'|"use client")/.test(l));
  return lines.length <= 12 && lines.every((l) => /^\s*(import|export)\b/.test(l) || !/<[A-Za-z]/.test(l));
}

const STOP_TERMS = new Set(['mantine', 'import', 'from', 'react', 'next', 'core', 'component', 'components', 'page', 'pages']);

/** Что искать в файлах, чтобы понять, есть ли там работа для задачи: термины заголовка и классы/теги из брифа. */
function taskTerms(t: PlannedTask): { literals: string[]; terms: string[] } {
  const head = goalTerms(t.title);
  const brief = goalTerms(t.brief);
  // буквальное: надпись на экране («Добавить») или класс/тег (af-table); className и прочие общие слова — нет
  const lit = (x: string) => /[а-яё]/i.test(x) || (/[-_<#]/.test(x) && x.length >= 4);
  const clean = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()).filter((x) => x.length >= 3 && !STOP_TERMS.has(x)))];
  return { literals: clean([...head.literals, ...brief.literals].filter(lit)), terms: clean(head.terms) };
}

/**
 * Шаблон с * (src/pages/*\/ui/*Page.tsx) попал прямо в files — так нельзя ни проверить границы, ни поручить модели 48 файлов.
 * Превращаем в правку по образцу: образец — первый подходящий файл, остальные повторит программа.
 * Разнородные файлы одного шаблона (…-list, …-edit, …-view) делим на подгруппы: правка списка к форме не подойдёт.
 * Подгруппы, где нечего менять (нет ни одного термина задачи), и файлы-обёртки отбрасываем.
 */
export function expandGlobTasks(plan: Plan, all: string[], read: (f: string) => string, warnings: string[] = []): Plan {
  const out: PlannedTask[] = [];
  const renamed = new Map<string, string[]>();
  const ids = new Set(plan.tasks.map((t) => t.id));
  for (const t of plan.tasks) {
    const norm = (f: string) => f.replace(/\\/g, '/').replace(/^\.\//, '');
    const globs = [...new Set([...(t.similar ? [norm(t.similar)] : []), ...t.files.filter((f) => f.includes('*')).map(norm)])];
    if (globs.length === 0) {
      out.push(t);
      continue;
    }
    const plain = t.files.filter((f) => !f.includes('*'));
    const pattern = globs[0]!;
    if (globs.length > 1) warnings.push(`${t.id}: в задаче несколько шаблонов (${globs.join(', ')}) — беру ${pattern}, остальное проверит приёмка.`);
    let matched = matchFiles(pattern, all);
    const wrappers = matched.filter((f) => isWrapperFile(safeRead(read, f)));
    if (wrappers.length === matched.length && matched.length) {
      warnings.push(`${t.id}: файлы ${pattern} — обёртки без разметки (только import/export), менять в них нечего.`);
      matched = [];
    }
    if (matched.length === 0) {
      const own = plain.filter((f) => !f.includes('*'));
      if (own.length || t.install?.length) out.push({ ...t, files: own, similar: undefined });
      else {
        if (!wrappers.length) warnings.push(`${t.id}: шаблон ${pattern} не нашёл файлов — задача убрана.`);
        else warnings[warnings.length - 1] += ' Задача убрана.';
        renamed.set(t.id, []);
      }
      continue;
    }
    // подгруппы по последнему слову имени: address-list / address-edit / address-view
    const re = templateRegex(pattern);
    const groups = new Map<string, string[]>();
    for (const f of matched) {
      const cap = re.exec(f)?.[1] ?? '';
      const key = /-([a-z0-9]+)$/i.exec(cap)?.[1] ?? '';
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    const split = groups.size >= 2 && groups.size <= 6 && !groups.has('') && [...groups.values()].every((g) => g.length >= 2);
    let parts: { pattern: string; files: string[] }[] = split
      ? [...groups].map(([k, files]) => ({ pattern: pattern.replace('*', `*-${k}`), files }))
      : [{ pattern, files: matched }];
    // в каких подгруппах есть что менять
    const tt = taskTerms(t);
    // есть надпись или класс — ищем их (точнее); иначе — термины кода из заголовка
    const terms = tt.literals.length ? tt.literals : tt.terms;
    if (terms.length && parts.length > 1) {
      const relevant = parts.filter((p) => p.files.some((f) => terms.some((x) => safeRead(read, f).toLowerCase().includes(x))));
      if (relevant.length && relevant.length < parts.length) {
        warnings.push(`${t.id}: в ${parts.filter((p) => !relevant.includes(p)).map((p) => p.pattern).join(', ')} нет того, что меняет задача (${terms.slice(0, 4).join(', ')}) — их не трогаю.`);
        parts = relevant;
      }
    }
    const newIds: string[] = [];
    for (const [i, part] of parts.entries()) {
      let id = t.id;
      if (i > 0) {
        id = `${t.id}-${/\*-([a-z0-9]+)/i.exec(part.pattern)?.[1] ?? i + 1}`;
        // занят (продолжение прогона снова считает раунды с 1) — буква, а не штрихи: D1.1b, D1.1c
    if (ids.has(id)) {
      const base = id;
      for (let k = 1; ids.has(id); k++) id = `${base}${k < 26 ? String.fromCharCode(97 + k) : k}`;
    }
        ids.add(id);
      }
      newIds.push(id);
      // образец: файл, который модель уже назвала, иначе первый по алфавиту
      const example = plain.find((f) => part.files.includes(f)) ?? [...part.files].sort()[0]!;
      const extra = i === 0 ? plain.filter((f) => !matched.includes(f)) : [];
      const task: PlannedTask = { ...t, id, files: [example, ...extra], similar: part.files.length >= 2 ? part.pattern : undefined };
      if (i > 0) task.install = undefined;
      out.push(task);
      warnings.push(`${id}: шаблон ${part.pattern} — правка в ${example}, программа повторит её ещё в ${part.files.length - 1} файлах.`);
    }
    if (newIds.length > 1 || newIds[0] !== t.id) renamed.set(t.id, newIds);
  }
  // зависимости от разделённой или убранной задачи
  for (const t of out) {
    t.dependsOn = [...new Set(t.dependsOn.flatMap((d) => renamed.get(d) ?? [d]))].filter((d) => d !== t.id);
  }
  return { ...plan, tasks: out };
}

function safeRead(read: (f: string) => string, f: string): string {
  try {
    return read(f);
  } catch {
    return '';
  }
}

/**
 * Задача только «поставить пакеты» (install есть, файлов нет): ставит программа, модель тут не нужна.
 * Переносим install в задачи, которые от неё зависят, а саму задачу убираем.
 */
export function foldInstallTasks(plan: Plan, warnings: string[] = []): Plan {
  let tasks = plan.tasks;
  for (const t of [...tasks]) {
    if (!t.install?.length || t.files.length || t.newFiles?.length) continue;
    const dependents = tasks.filter((d) => d.dependsOn.includes(t.id));
    if (!dependents.length) continue;
    for (const d of dependents) {
      d.install = [...new Set([...(d.install ?? []), ...t.install])];
      d.dependsOn = [...new Set([...d.dependsOn.filter((x) => x !== t.id), ...t.dependsOn])];
    }
    tasks = tasks.filter((x) => x !== t);
    warnings.push(`${t.id}: пакеты ${t.install.join(', ')} поставит программа перед ${dependents.map((d) => d.id).join(', ')} — отдельная задача не нужна.`);
  }
  return { ...plan, tasks };
}

/** Команда проверки должна что-то проверять, а не менять файлы: sed, rm, mv и перенаправления — мимо. */
export function isCheckCommand(cmd: string, commands?: ProjectCommands): boolean {
  const c = cmd.trim();
  if (!c) return false;
  const known = [commands?.test, commands?.typecheck, commands?.lint].filter((x): x is string => !!x);
  if (known.some((k) => c === k || c.startsWith(`${k} `))) return true;
  if (/(^|[\s;&|])(sed|rm|mv|cp|chmod|del|git\s+(checkout|reset|push|commit))\b|>|\$\(/.test(c)) return false;
  // grep/findstr/test — самодельные «проверки»: в Windows их нет, а «grep -q … || exit 1» на отсутствие падает всегда
  if (/(^|[;&|(]\s*)(grep|egrep|rg|findstr|select-string|test|\[|cat|ls|find|wc|exit)(\s|$)/.test(c)) return false;
  return /^(npm|npx|node|pnpm|yarn|bun|tsc|vitest|jest|mocha|pytest|python3?\s+-m\s+pytest|go\s+test|cargo\s+test|dotnet\s+test|make\s+test)\b/.test(c);
}

/**
 * Команда в критерии дублирует проверку типов или линтер проекта (npx tsc --noEmit, npm run lint…).
 * Каскад и так запускает их ступенями 4–5 — с учётом ошибок, бывших до прогона. Отдельной командой они падают
 * на старых ошибках проекта, и агенты бросаются «чинить» чужие файлы (прогон 20261020112744).
 */
export function isRedundantCheck(cmd: string, commands?: ProjectCommands): boolean {
  const c = cmd.trim().replace(/\s+/g, ' ');
  const known = [commands?.typecheck, commands?.lint].filter((x): x is string => !!x).map((x) => x.replace(/\s+/g, ' '));
  if (known.some((k) => c === k || c.startsWith(`${k} `))) return true;
  if (/(^|\s)(npx\s+(--no-install\s+)?)?tsc(\s|$)/.test(c) || /npm\s+run\s+(typecheck|type-check|tsc|lint)\b/.test(c) || /(^|\s)(npx\s+)?eslint(\s|$)/.test(c)) return true;
  return false;
}

/** Слова названия без окончаний и служебных слов — чтобы «Заменить кнопки на Button» и «Замена кнопок на Button» совпали. */
function stems(text: string): Set<string> {
  const STOP = new Set(['и', 'в', 'во', 'на', 'с', 'со', 'по', 'для', 'из', 'к', 'от', 'до', 'the', 'a', 'to', 'in', 'of', 'and', 'all', 'все', 'всех', 'задача']);
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}@/.\- ]+/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w))
      .map((w) => (/^[а-яё]+$/.test(w) ? w.slice(0, 5) : w.slice(0, 7))),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  // пустые названия сравнить не по чему — не дубль
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}

/**
 * Одинаковые задачи — одна задача. Маленькая модель-планировщик часто повторяет шаг дважды
 * («Подключить MantineProvider» и «Обернуть layout в MantineProvider» с теми же файлами) — на доске это куча одинаковых карточек.
 * Дубль — тот же тип, те же файлы (или одни внутри других) и почти то же название или бриф. Одинаковая правка в РАЗНЫХ файлах —
 * не дубль: её объединит классификатор пулов.
 */
export function mergeDuplicates(plan: Plan, warnings: string[] = []): Plan {
  const tasks = plan.tasks.map((t) => ({ ...t, dependsOn: [...t.dependsOn], files: [...t.files] }));
  const gone = new Map<string, string>();
  const subset = (a: string[], b: string[]) => a.every((f) => b.includes(f));
  for (let i = 0; i < tasks.length; i++) {
    const a = tasks[i]!;
    if (gone.has(a.id)) continue;
    for (let j = i + 1; j < tasks.length; j++) {
      const b = tasks[j]!;
      if (gone.has(b.id) || a.type !== b.type || a.similar !== b.similar) continue;
      if (!(subset(a.files, b.files) || subset(b.files, a.files))) continue;
      if (a.dependsOn.includes(b.id) || b.dependsOn.includes(a.id)) continue;
      const same = jaccard(stems(a.title), stems(b.title)) >= 0.6 || jaccard(stems(a.brief), stems(b.brief)) >= 0.7;
      if (!same) continue;
      // b вливается в a: файлы, критерий, шаги, пакеты — объединяются
      a.files = [...new Set([...a.files, ...b.files])];
      a.newFiles = [...new Set([...(a.newFiles ?? []), ...(b.newFiles ?? [])])];
      if (!a.newFiles.length) delete a.newFiles;
      a.accept = { tests: [...new Set([...a.accept.tests, ...b.accept.tests])], commands: [...new Set([...a.accept.commands, ...b.accept.commands])] };
      if (b.brief && !a.brief.includes(b.brief)) a.brief = `${a.brief}\n${b.brief}`;
      if (b.steps?.length) a.steps = [...new Set([...(a.steps ?? []), ...b.steps])].slice(0, 10);
      if (b.install?.length) a.install = [...new Set([...(a.install ?? []), ...b.install])];
      if (b.inputs?.length) a.inputs = [...new Set([...(a.inputs ?? []), ...b.inputs])];
      a.dependsOn = [...new Set([...a.dependsOn, ...b.dependsOn])];
      a.stage ??= b.stage;
      gone.set(b.id, a.id);
    }
  }
  if (!gone.size) return plan;
  const out = tasks
    .filter((t) => !gone.has(t.id))
    .map((t) => ({ ...t, dependsOn: [...new Set(t.dependsOn.map((d) => gone.get(d) ?? d))].filter((d) => d !== t.id) }));
  warnings.push(`Склеил одинаковые задачи: ${[...gone].map(([b, a]) => `${b} → ${a}`).join(', ')}.`);
  return { ...plan, tasks: out };
}

export function validatePlan(input: Plan, repoDir: string, tier: Tier, commands?: ProjectCommands): PlanCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  let plan = linkTestTasks(expandTestFirst(structuredClone(input)), warnings);
  const stacks = existsSync(repoDir) ? detectStacks(repoDir) : undefined;
  if (commands) plan = adaptToProject(plan, commands, warnings, stacks);
  const allFiles = existsSync(repoDir) ? listFiles(repoDir) : [];
  plan = expandGlobTasks(plan, allFiles, (f) => readFileSync(path.join(repoDir, f), 'utf8'), warnings);
  plan = foldInstallTasks(plan, warnings);
  plan = mergeDuplicates(plan, warnings);
  for (const t of plan.tasks) {
    const bad = t.accept.commands.filter((c) => !isCheckCommand(c, commands));
    if (bad.length) {
      t.accept.commands = t.accept.commands.filter((c) => isCheckCommand(c, commands));
      warnings.push(`${t.id}: убрал «проверки», которые меняют файлы или ничего не проверяют: ${bad.join('; ')}.`);
    }
    const dup = t.accept.commands.filter((c) => isRedundantCheck(c, commands));
    if (dup.length) {
      t.accept.commands = t.accept.commands.filter((c) => !isRedundantCheck(c, commands));
      warnings.push(`${t.id}: проверку типов и линтер программа и так запускает (с учётом старых ошибок проекта) — убрал из критерия: ${dup.join('; ')}.`);
    }
  }
  if (plan.tasks.length === 0) errors.push('В плане не осталось задач, где есть что менять.');
  const repoExists = existsSync(repoDir);
  // в проекте из частей — по командам части, где лежат файлы задачи (у web/ может не быть тестов, хотя у backend/ есть)
  const scope = (t: PlannedTask) => (commands ? scopedCommands([...t.files, ...(t.newFiles ?? [])], stacks, commands) : null);
  const noRunnerOf = (t: PlannedTask) => {
    const c = scope(t);
    return !!c && !c.test && !c.testFiles;
  };
  const limits = TIER_LIMITS[tier];
  const ids = new Set<string>();

  for (const t of plan.tasks) {
    if (ids.has(t.id)) errors.push(`Повторяется id задачи ${t.id}.`);
    ids.add(t.id);
  }

  for (const t of plan.tasks) {
    for (const d of t.dependsOn) {
      if (!ids.has(d)) errors.push(`${t.id}: зависит от несуществующей задачи ${d}.`);
    }
    // проверяемый критерий готовности обязателен
    const noRunner = noRunnerOf(t);
    const nothingToCheck = noRunner && !scope(t)!.typecheck;
    // задача не про код (пересказ, разбор, извлечение данных): критерий — сам файл-результат, его проверит программа
    const doc = isDocTask(t);
    for (const f of t.inputs ?? []) {
      if (path.isAbsolute(f) || f.split(/[\\/]/).includes('..')) errors.push(`${t.id}: исходный файл ${f} вне папки проекта.`);
      else if (repoExists && !existsSync(path.join(repoDir, f))) errors.push(`${t.id}: исходного файла ${f} нет в папке.`);
      else if (!READABLE.test(f)) warnings.push(`${t.id}: формат ${f} программа читать не умеет — исполнитель увидит только имя файла.`);
    }
    if ((t.type === 'edit' || t.type === 'test') && !doc && t.accept.tests.length + t.accept.commands.length === 0) {
      if (nothingToCheck) warnings.push(`${t.id}: проверить программой нечем (нет ни тестов, ни проверки типов) — только синтаксис и ревью моделью.`);
      else if (noRunner) {
        /* критерий — проверка типов, предупреждение уже есть */
      } else errors.push(`${t.id}: нет критерия готовности — укажи тест или команду.`);
    }
    // файлы должны существовать или быть объявлены новыми
    const newFiles = new Set(t.newFiles ?? []);
    for (const f of t.files) {
      if (path.isAbsolute(f) || f.split(/[\\/]/).includes('..')) {
        errors.push(`${t.id}: путь ${f} выходит за пределы проекта.`);
      } else if (!newFiles.has(f) && !existsSync(path.join(repoDir, f))) {
        // модель забыла пометить файл новым: это не повод ронять весь план — помечаем сами
        t.newFiles = [...(t.newFiles ?? []), f];
        warnings.push(`${t.id}: файла ${f} пока нет — задача его создаст.`);
      }
    }
    if (t.type === 'edit' && t.files.length > limits.maxFiles) {
      errors.push(`${t.id}: ${t.files.length} файлов в задаче, а для тира ${tier} можно не больше ${limits.maxFiles}. Раздели задачу.`);
    }
  }

  // установка пакетов: только для правок, только в проектах с package.json, только допустимые имена
  for (const t of plan.tasks) {
    if (!t.install?.length) continue;
    t.install = [...new Set(t.install.map((x) => String(x).trim()).filter(Boolean))];
    const bad = t.install.filter((x) => !validSpec(x));
    if (bad.length) errors.push(`${t.id}: недопустимые имена пакетов: ${bad.join(', ')}.`);
    else {
      // проект из частей: пакеты ставятся в node-часть файлов задачи (web/), а не в корень
      const dir = stacks?.length ? nodeDirFor([...t.files, ...(t.newFiles ?? [])], stacks) : '';
      if (dir === null || !existsSync(path.join(repoDir, dir, 'package.json'))) {
        // ставить некуда — не повод ронять план: пакеты убираем, правка пойдёт без них (проверки покажут, если они нужны)
        warnings.push(`${t.id}: пакеты ${t.install.join(', ')} ставить некуда — у файлов задачи нет package.json; убрал установку.`);
        delete t.install;
      } else warnings.push(`${t.id}: перед работой будут установлены пакеты npm${dir ? ` в ${dir}/` : ''}: ${t.install.join(', ')}.`);
    }
  }

  // правка по образцу: шаблон должен находить несколько файлов, образец — один из них
  const all = allFiles;
  for (const t of plan.tasks) {
    if (!t.similar) continue;
    const pattern = t.similar.replace(/\\/g, '/').replace(/^\.\//, '');
    const matched = matchFiles(pattern, all);
    if (t.type !== 'edit' || matched.length < 2) {
      warnings.push(`${t.id}: шаблон ${t.similar} нашёл ${matched.length} файл(ов) — правка по образцу отключена.`);
      delete t.similar;
      continue;
    }
    t.similar = pattern;
    if (!t.files.some((f) => matched.includes(f))) t.files = [matched[0]!, ...t.files].slice(0, Math.max(1, t.files.length));
    warnings.push(`${t.id}: правка в ${t.files[0]} будет повторена ещё в ${matched.length - 1} файлах по шаблону ${pattern}.`);
  }

  if (hasCycle(plan.tasks)) errors.push('В плане есть цикл зависимостей.');

  // файловый замок: независимые задачи не правят один файл — иначе ставим зависимость
  if (errors.length === 0) {
    for (let i = 0; i < plan.tasks.length; i++) {
      for (let j = i + 1; j < plan.tasks.length; j++) {
        const a = plan.tasks[i]!;
        const b = plan.tasks[j]!;
        const shared = a.files.filter((f) => b.files.includes(f));
        if (shared.length === 0) continue;
        if (isAncestor(plan.tasks, a.id, b.id) || isAncestor(plan.tasks, b.id, a.id)) continue;
        b.dependsOn.push(a.id);
        warnings.push(`${b.id} и ${a.id} правят ${shared.join(', ')} — поставил ${b.id} после ${a.id}.`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, plan };
}

function hasCycle(tasks: PlannedTask[]): boolean {
  const state = new Map<string, 0 | 1 | 2>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visit = (id: string): boolean => {
    const s = state.get(id) ?? 0;
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(id, 1);
    for (const d of byId.get(id)?.dependsOn ?? []) if (visit(d)) return true;
    state.set(id, 2);
    return false;
  };
  return tasks.some((t) => visit(t.id));
}

/** Верно ли, что a — предшественник b (прямо или через других). */
function isAncestor(tasks: PlannedTask[], a: string, b: string): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const stack = [...(byId.get(b)?.dependsOn ?? [])];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === a) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(byId.get(cur)?.dependsOn ?? []));
  }
  return false;
}

/** Небольшой план можно не подтверждать: до двух задач, без установки пакетов и без правки по образцу. */
export function isSmallPlan(plan: Plan): boolean {
  return plan.tasks.length <= 2 && plan.tasks.every((t) => !t.install?.length && !t.similar);
}
