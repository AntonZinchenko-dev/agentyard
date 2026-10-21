// Части проекта (monorepo): каждая задача проверяется командами той части, где лежат её файлы.
//
// Прогон 20261020144005: проект «backend на Go + web на Next». Задача про web/app/layout.tsx проверялась
// `go test` бэкенда, который был красным ещё до прогона (нет go.sum). Пять попыток, дробление, «старший» — и человек,
// хотя правка была верной с первого раза. Отсюда правила:
//   - команды задачи — только частей, которым принадлежат её файлы;
//   - тесты задачи запускает раннер её части (пути — от папки части); у части нет раннера — тестов у задачи нет;
//   - пакеты ставятся в папку части (web/), а не в корень, где нет package.json;
//   - ссылки на node_modules в рабочих копиях — для каждой части.

import path from 'node:path';
import type { ProjectCommands } from '../repomap.ts';
import { MULTI, type Stack } from '../stacks.ts';

const norm = (f: string) => f.replace(/\\/g, '/').replace(/^\.\//, '');

/** Часть проекта, которой принадлежит файл: самая глубокая папка-префикс; корневая часть — запасная. */
export function stackOf(file: string, stacks: Stack[]): Stack | null {
  const f = norm(file);
  let best: Stack | null = null;
  for (const s of stacks) {
    if (!s.dir) {
      if (!best) best = s;
      continue;
    }
    if ((f === s.dir || f.startsWith(`${s.dir}/`)) && (!best || best.dir.length < s.dir.length)) best = s;
  }
  return best;
}

/** Части, которым принадлежат файлы (без повторов, в порядке частей). */
export function stacksOf(files: string[], stacks: Stack[]): Stack[] {
  const owners = new Set(files.map((f) => stackOf(f, stacks)).filter((s): s is Stack => !!s));
  return stacks.filter((s) => owners.has(s));
}

/** Путь файла от папки его части. */
export function relToStack(file: string, stack: Stack): string {
  const f = norm(file);
  return stack.dir && f.startsWith(`${stack.dir}/`) ? f.slice(stack.dir.length + 1) : f;
}

function inDir(dir: string, cmd: string | null): string | null {
  if (!cmd) return null;
  return dir ? `cd "${dir}" && ${cmd}` : cmd;
}

/** Проект из нескольких частей (иначе команды проекта и есть команды задачи). */
export function isMulti(stacks: Stack[] | undefined): boolean {
  return !!stacks && (stacks.length > 1 || (stacks.length === 1 && !!stacks[0]!.dir));
}

/**
 * Команды проверки для файлов задачи: только части этих файлов. Файлы вне частей (README в корне, docker-compose)
 * проверять нечем — команды пустые, остаются синтаксис, признаки готовности и ревью.
 */
export function scopedCommands(files: string[], stacks: Stack[] | undefined, all: ProjectCommands): ProjectCommands {
  if (!isMulti(stacks) || files.length === 0) return all;
  const owners = stacksOf(files, stacks!);
  const join = (key: 'test' | 'lint' | 'typecheck') => {
    const parts = owners.map((s) => inDir(s.dir, s[key])).filter((x): x is string => !!x);
    return parts.length ? parts.join(MULTI) : null;
  };
  const single = owners.length === 1 ? owners[0]! : null;
  return {
    test: join('test'),
    // шаблон запуска отдельных файлов — с путями от папки части (см. testCommandsFor)
    testFiles: single?.testFiles ? inDir(single.dir, single.testFiles) : null,
    lint: join('lint'),
    typecheck: join('typecheck'),
  };
}

export interface TestPlan {
  /** Команды, которые запускают тесты задачи. */
  commands: string[];
  /** Тестовые файлы, которые запустить нечем: у их части нет тест-раннера (или файл вне частей). */
  unrunnable: string[];
  /**
   * Команды запускают ровно тесты задачи (шаблон с файлами), а не весь набор. Тогда каждое падение — задачи:
   * «тест падал и раньше» не оправдание, его и надо было починить. Весь набор — только как замена: там старые чужие падения не в счёт.
   */
  specific: boolean;
}

/** Как запустить тестовые файлы задачи: раннером их части, пути — от папки части. */
export function testCommandsFor(tests: string[], stacks: Stack[] | undefined, all: ProjectCommands): TestPlan {
  if (tests.length === 0) return { commands: [], unrunnable: [], specific: true };
  if (!isMulti(stacks)) {
    if (all.testFiles) return { commands: [all.testFiles.replace('{files}', tests.map((t) => `"${t}"`).join(' '))], unrunnable: [], specific: true };
    return all.test ? { commands: [all.test], unrunnable: [], specific: false } : { commands: [], unrunnable: [...tests], specific: false };
  }
  const byStack = new Map<Stack, string[]>();
  const unrunnable: string[] = [];
  for (const t of tests) {
    const s = stackOf(t, stacks!);
    if (!s || (!s.testFiles && !s.test)) {
      unrunnable.push(t);
      continue;
    }
    byStack.set(s, [...(byStack.get(s) ?? []), t]);
  }
  const commands: string[] = [];
  let specific = true;
  for (const [s, files] of byStack) {
    if (s.testFiles) commands.push(inDir(s.dir, s.testFiles.replace('{files}', files.map((f) => `"${relToStack(f, s)}"`).join(' ')))!);
    else {
      commands.push(inDir(s.dir, s.test)!);
      specific = false;
    }
  }
  return { commands, unrunnable, specific };
}

/** Есть ли у части, где лежат файлы, чем запускать тесты. */
export function hasTestRunner(files: string[], stacks: Stack[] | undefined, all: ProjectCommands): boolean {
  if (!isMulti(stacks)) return !!(all.test || all.testFiles);
  const owners = stacksOf(files, stacks!);
  return owners.length > 0 && owners.every((s) => !!(s.test || s.testFiles));
}

/** Папка node-части, куда ставить пакеты для этих файлов ('' — корень). null — node-части нет. */
export function nodeDirFor(files: string[], stacks: Stack[] | undefined): string | null {
  if (!stacks?.length) return '';
  const owners = stacksOf(files, stacks).filter((s) => s.id === 'node');
  if (owners.length) return owners[0]!.dir;
  const nodes = stacks.filter((s) => s.id === 'node');
  return nodes.length === 1 ? nodes[0]!.dir : nodes.find((s) => !s.dir)?.dir ?? null;
}

/** Папки, где в рабочих копиях нужны ссылки на зависимости (node_modules, .venv): корень и все части. */
export function dependencyDirs(stacks: Stack[] | undefined): string[] {
  return [...new Set(['', ...(stacks ?? []).map((s) => s.dir)])];
}

/** Куда положить тест для файла: рядом с кодом части (web/tests/…), а не в корень проекта, где его никто не запустит. */
export function testHome(file: string, stacks: Stack[] | undefined): string {
  const s = stacks ? stackOf(file, stacks) : null;
  return s?.dir ? path.posix.join(s.dir, 'tests') : 'tests';
}

/**
 * Команда «на весь проект» (весь набор тестов, проверка типов, линтер части), а не проверка именно этой задачи.
 * Только для таких команд старые падения не в счёт: своя команда задачи (node check.mjs, тест её файла) должна просто пройти —
 * она и написана, чтобы падать до правки и проходить после.
 */
export function isProjectWide(cmd: string, stacks: Stack[] | undefined, all: ProjectCommands): boolean {
  const c = cmd.trim().replace(/\s+/g, ' ');
  const known = new Set<string>();
  for (const x of [all.test, all.lint, all.typecheck]) if (x) for (const part of x.split(MULTI)) known.add(part.trim());
  for (const s of stacks ?? []) for (const x of [s.test, s.lint, s.typecheck]) if (x) {
    known.add(x);
    known.add(inDir(s.dir, x)!);
  }
  return known.has(c) || /^(cd "[^"]+" && )?(npm (run )?test|npm run (lint|typecheck|build)|go test \.\/\.\.\.|go vet \.\/\.\.\.|cargo test|pytest|python -m pytest|dotnet test|mvn -q test|\.\/gradlew test)$/.test(c);
}
