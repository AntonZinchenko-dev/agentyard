// Разбор неудачи: чья она и что с ней делать.
//
// Лестница эскалации (повтор → аналитик → дробление → старшая модель → человек) нужна, когда ошибается модель.
// Но многие неудачи — не её: проверка падала и до прогона, в части проекта нет нужного пакета, Ollama не ответила,
// у команды нет утилиты. Гонять по таким неудачам лестницу — значит потратить все попытки и позвать человека
// на задачу, которую модель сделала верно с первого раза. Поэтому сначала — класс неудачи.

import { builtinModules } from 'node:module';

export type FailureClass =
  /** ошибка в файлах задачи — работа модели */
  | 'own'
  /** правка сломала другие файлы */
  | 'collateral'
  /** окружение: нет пакета, утилиты, сети, go.sum */
  | 'environment'
  /** модель ответила не по формату */
  | 'format'
  /** сбой модели или Ollama: тайм-аут, обрыв */
  | 'infra'
  /** ревьюер вернул */
  | 'review'
  /** конфликт слияния */
  | 'conflict';

export interface EnvIssue {
  kind: 'missing-package' | 'tool' | 'gosum' | 'pymodule' | 'network';
  /** Пакеты npm, которых не хватает. */
  packages?: string[];
  detail: string;
}

export interface Triage {
  cls: FailureClass;
  /** Файлы, о которых говорит ошибка (от корня проекта, если удалось сопоставить). */
  files: string[];
  env?: EnvIssue;
  /** Сколько ошибок в выводе — для «есть ли прогресс». */
  errors: number;
  why: string;
}

const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** Имя пакета npm из спецификатора импорта: «@mantine/core/styles.css» → «@mantine/core». null — относительный, алиас или встроенный. */
export function packageOfSpecifier(spec: string): string | null {
  if (!spec || /^[./~#]|^@\//.test(spec) || spec.startsWith('node:') || BUILTIN.has(spec)) return null;
  if (/^[a-z]:[\\/]/i.test(spec) || spec.includes('\\')) return null;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  if (BUILTIN.has(name)) return null;
  return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name) ? name : null;
}

/** Пакеты, которые импортирует код (import … from, import '…', require, import()). */
export function importedPackageNames(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/(?:\bfrom\s+|\bimport\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g)) {
    const p = packageOfSpecifier(m[1]!);
    if (p) out.add(p);
  }
  return [...out];
}

/** Пакеты, которые код импортирует, а в зависимостях части их нет (и типы для них — @types/x — тоже не в счёт). */
export function missingPackages(code: string, deps: Set<string>): string[] {
  return importedPackageNames(code).filter((p) => !deps.has(p) && !deps.has(`@types/${p.replace(/^@/, '').replace('/', '__')}`));
}

/** Пакеты, которых не нашёл сборщик или проверка типов. */
export function missingFromOutput(output: string): string[] {
  const out = new Set<string>();
  const res = [
    /Cannot find module '([^']+)' or its corresponding type declarations/g,
    /Module not found: (?:Error: )?Can't resolve '([^']+)'/g,
    /Cannot find (?:module|package) '([^']+)'(?! or its)/g,
    /Failed to resolve import "([^"]+)"/g,
  ];
  for (const re of res) for (const m of output.matchAll(re)) {
    const p = packageOfSpecifier(m[1]!);
    if (p) out.add(p);
  }
  return [...out];
}

const FILE_RE = /(?:^|[\s('"`])((?:[A-Za-z]:)?[\w@.()[\]\-/\\]+\.(?:[cm]?[jt]sx?|go|py|rs|java|kt|cs|php|rb|vue|svelte|css|scss|less|json|ya?ml))(?=[\s(:'"`,]|$)/gm;

/** Файлы, о которых говорит вывод, сопоставленные с известными путями проекта (по совпадению хвоста пути). */
export function filesInOutput(output: string, known: string[]): string[] {
  const out = new Set<string>();
  const norm = known.map((k) => k.replace(/\\/g, '/'));
  for (const m of output.matchAll(FILE_RE)) {
    const f = m[1]!.replace(/\\/g, '/').replace(/^\.\//, '');
    const hit = norm.find((k) => k === f || k.endsWith(`/${f}`) || f.endsWith(`/${k}`));
    out.add(hit ?? f);
  }
  return [...out];
}

function errorCount(output: string): number {
  return output.split(/\r?\n/).filter((l) => /\berror\b|^\s*\S+\.go:\d+:\d+: |^--- FAIL|^not ok |^FAIL\s|^[✕×]\s|^FAILED\s/i.test(l)).length;
}

export interface TriageContext {
  /** Файлы задачи и то, что правка изменила. */
  taskFiles: string[];
  changedFiles: string[];
  /** Все файлы проекта — чтобы узнать «чужие» файлы в выводе. */
  projectFiles?: string[];
}

/** Класс неудачи по подписи и выводу. */
export function triage(signature: string, output: string, ctx: TriageContext): Triage {
  const errors = errorCount(output);
  const mine = new Set([...ctx.taskFiles, ...ctx.changedFiles].map((f) => f.replace(/\\/g, '/')));
  // строки «Команда: node check.mjs» и «Ступень 6 (…)» — наша обвязка, а не место ошибки
  const body = output.split(/\r?\n/).filter((l) => !/^(Команда:|Ступень \d|Новые (ошибки|падения)|ПОДСКАЗКА:)/.test(l.trim())).join('\n');
  const files = filesInOutput(body, [...mine, ...(ctx.projectFiles ?? [])]);
  const base = { files, errors };
  if (/^format\b/.test(signature)) return { ...base, cls: 'format', why: 'ответ не по формату' };
  if (/^review:/.test(signature)) return { ...base, cls: 'review', why: 'ревьюер вернул' };
  if (/^conflict/.test(signature)) return { ...base, cls: 'conflict', why: 'конфликт слияния' };
  if (/^agent:/.test(signature)) {
    if (/не ответила|замолчала|Ollama|оборван|ECONNRESET|fetch failed|socket|тайм-аут|timeout/i.test(output)) return { ...base, cls: 'infra', why: 'модель или Ollama не ответили' };
    return { ...base, cls: 'format', why: 'исполнитель не сдал работу' };
  }
  const missing = missingFromOutput(output);
  if (missing.length) return { ...base, cls: 'environment', env: { kind: 'missing-package', packages: missing, detail: `в части проекта нет пакетов: ${missing.join(', ')}` }, why: 'нет пакета' };
  if (/is not recognized as an internal or external command|command not found|: not found\b/i.test(output)) return { ...base, cls: 'environment', env: { kind: 'tool', detail: output.split(/\r?\n/).find((l) => /not recognized|not found/i.test(l))?.trim() ?? 'нет утилиты' }, why: 'нет утилиты' };
  if (/missing go\.sum entry/.test(output)) return { ...base, cls: 'environment', env: { kind: 'gosum', detail: 'в go.sum нет записей модулей — нужен `go mod tidy` в папке Go-части' }, why: 'нет go.sum' };
  if (/No module named '([^']+)'/.test(output)) return { ...base, cls: 'environment', env: { kind: 'pymodule', detail: `не установлен модуль Python ${/No module named '([^']+)'/.exec(output)![1]}` }, why: 'нет модуля Python' };
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo/i.test(output)) return { ...base, cls: 'environment', env: { kind: 'network', detail: 'нет сети' }, why: 'нет сети' };
  // ошибка называет файлы: среди них есть файлы задачи — своя; только чужие — правка задела другие файлы
  const named = files.filter((f) => /\//.test(f) || ctx.projectFiles?.includes(f));
  if (named.length && !named.some((f) => mine.has(f) || [...mine].some((m) => m.endsWith(`/${f}`)))) {
    return { ...base, cls: 'collateral', why: `ошибка в других файлах: ${named.slice(0, 3).join(', ')}` };
  }
  return { ...base, cls: 'own', why: 'ошибка в файлах задачи' };
}
