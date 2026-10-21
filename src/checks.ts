// Уровень 5. Каскад проверок — от дешёвых к дорогим, остановка на первой проваленной.
// Ступени 1 (заплатка применилась) проверяет агент; здесь — со 2-й по 6-ю.
// Ступень 7 (ревью моделью) и 8 (полный набор тестов) запускает конвейер.

import { exec } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { CHECKS } from './config.ts';
import type { ProjectCommands } from './repomap.ts';
import { MULTI } from './stacks.ts';
import { hasLine, hasMarker } from './rules.ts';
import type { CheckResult, DoneCheck, Task } from './types.ts';

/**
 * Признаки готовности (doneWhen): чего в файле остаться не должно и что должно появиться.
 * Возвращает понятный текст для исполнителя или null, если всё на месте.
 */
export function doneWhenProblems(checks: DoneCheck[] | undefined, workdir: string): string | null {
  const out: string[] = [];
  for (const c of checks ?? []) {
    const abs = path.join(workdir, c.file);
    if (!existsSync(abs)) {
      if (c.has?.length) out.push(`${c.file}: файла нет.`);
      continue;
    }
    const text = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    const left = (c.lacks ?? []).filter((m) => hasMarker(text, m));
    const missing = (c.has ?? []).filter((m) => (/\s/.test(m) || /^(import|from|use|using|require)\b/.test(m) ? !hasLine(text, m) && !text.includes(m) : !hasMarker(text, m)));
    if (left.length) out.push(`${c.file}: ещё осталось ${left.map((m) => `\`${m}\``).join(', ')} — замени так же, как в образце (все вхождения).`);
    if (missing.length) out.push(`${c.file}: нет ${missing.map((m) => `\`${m}\``).join(', ')}.`);
  }
  return out.length ? out.join('\n') : null;
}

export interface CommandResult {
  code: number;
  output: string;
  ms: number;
}

/** Быстрая проверка синтаксиса одного файла утилитой языка (если она есть на компьютере). */
const SYNTAX: Record<string, string> = {
  '.py': 'python -m py_compile {file}',
  '.php': 'php -l {file}',
  '.rb': 'ruby -c {file}',
  '.go': 'gofmt -e -l {file}',
};

/** Команды нет на компьютере (Windows: 9009, sh: 127, заглушка Microsoft Store для python). */
export function toolMissing(r: CommandResult): boolean {
  return r.code === 127 || r.code === 9009 || /is not recognized as an internal or external command|command not found|not found: |Python was not found|No such file or directory/i.test(r.output);
}

/** Запуск команды в оболочке с тайм-аутом. Работает и в Windows (cmd), и в Linux/Mac. */
export async function runCommand(cmd: string, cwd: string, timeoutMs = CHECKS.commandTimeoutMs): Promise<CommandResult> {
  // составная команда (несколько частей проекта): все части по очереди, ошибка — если упала любая
  if (cmd.includes(MULTI)) {
    const started = Date.now();
    let code = 0;
    const outs: string[] = [];
    for (const part of cmd.split(MULTI)) {
      const r = await runOne(part, cwd, timeoutMs);
      if (r.code !== 0 && code === 0) code = r.code;
      if (r.output) outs.push(r.output);
    }
    return { code, output: outs.join('\n'), ms: Date.now() - started };
  }
  return runOne(cmd, cwd, timeoutMs);
}

function runOne(cmd: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  const started = Date.now();
  // переменная тест-раннера Node «протекает» во вложенные запуски и меняет их поведение — убираем
  const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env;
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...env, CI: '1', FORCE_COLOR: '0' } }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      const killed = err && (err as { killed?: boolean }).killed;
      const output = `${stdout}\n${stderr}${killed ? `\n[остановлено по тайм-ауту ${timeoutMs / 1000} с]` : ''}`.trim();
      resolve({ code, output, ms: Date.now() - started });
    });
  });
}

export interface CheckInput {
  task: Task;
  workdir: string;
  changedFiles: string[];
  changedLines: number;
  maxChangedLines: number;
  commands: ProjectCommands;
  /** Ошибки линтера и типов, которые были ещё до прогона: падаем только на новых. */
  knownErrors?: { lint?: Map<string, number>; typecheck?: Map<string, number> };
  /** Какая ступень идёт сейчас — для живой строки в окне. */
  onStage?: (text: string) => void;
  /** Стиль модулей проекта — чтобы сразу ловить module.exports в проекте на import/export. */
  moduleSystem?: 'esm' | 'cjs' | null;
  /** Команды тестов задачи (раннер её части проекта). Не задано — по командам проекта. */
  testCommands?: string[];
  /** Команды тестов запускают ровно тесты задачи: их падения — всегда задачи, сравнение с исходным состоянием не применяется. */
  testsStrict?: boolean;
  /** Команда «на весь проект» (весь набор тестов, сборка): только для таких старые падения не в счёт. Своя команда задачи должна пройти. */
  projectWide?: (cmd: string) => boolean;
  /**
   * Сравнение с исходным состоянием: та же команда на ветке прогона до первой задачи.
   * preexisting — всё это падало и раньше; fresh — новые падения. null — сравнить не получилось.
   */
  compare?: (cmd: string, r: CommandResult) => Promise<{ preexisting: boolean; fresh: string[]; before: number } | null>;
}

/**
 * Каскад для задачи-правки (edit) и задачи-теста (test).
 * Для test ожидается обратное: новый тест обязан упасть («красный»).
 */
export async function runCascade(input: CheckInput): Promise<CheckResult> {
  const started = Date.now();
  const { task, workdir, commands } = input;
  const notes: string[] = [];
  const result = (passed: boolean, stage: number, stageName: string, output: string, signature = ''): CheckResult => ({
    passed,
    stage,
    stageName,
    output,
    signature: passed ? '' : `${stage}:${signature || firstLine(output)}`,
    durationMs: Date.now() - started,
    ...(notes.length ? { notes } : {}),
  });
  /** Падение команды: было ли оно и до прогона. */
  const judge = async (cmd: string, r: CommandResult) => {
    if (!input.compare) return null;
    try {
      return await input.compare(cmd, r);
    } catch {
      return null;
    }
  };

  // 2. Границы: размер изменений и запрещённые файлы
  if (input.changedFiles.length === 0) return result(false, 2, 'границы', 'Изменений нет — задача не выполнена.', 'empty');
  const forbidden = input.changedFiles.filter((f) => CHECKS.forbidden.some((re) => re.test(f)));
  if (forbidden.length) return result(false, 2, 'границы', `Тронуты запрещённые файлы: ${forbidden.join(', ')}`, 'forbidden');
  const frozenTouched = input.changedFiles.filter((f) => task.frozenFiles.includes(f));
  if (frozenTouched.length) return result(false, 2, 'границы', `Изменены замороженные тесты: ${frozenTouched.join(', ')}`, 'frozen');
  if (input.changedLines > input.maxChangedLines) {
    return result(false, 2, 'границы', `Изменено ${input.changedLines} строк при лимите ${input.maxChangedLines}. Задачу нужно дробить.`, 'too-big');
  }

  // 2б. Признаки готовности: правка сделана целиком (не осталось старых тегов, импорт на месте)
  const notDone = doneWhenProblems(task.doneWhen, workdir);
  if (notDone) return result(false, 2, 'признаки готовности', `Правка сделана не целиком:\n${notDone}`, `done-when:${notDone.split('\n')[0]!.replace(/[^:]*: /, '').slice(0, 80)}`);

  const mark = (text: string) => {
    try {
      input.onStage?.(text);
    } catch {
      /* окно не роняет проверки */
    }
  };
  // 3. Синтаксис: для JS — node --check, для JSON — разбор
  mark('синтаксис изменённых файлов');
  for (const f of input.changedFiles) {
    const abs = path.join(workdir, f);
    if (!existsSync(abs)) continue;
    // результат задачи не про код (out/summary.md, out/data.csv): не пустой и ровный по формату
    const dataErr = dataFileProblem(f, abs, !!task.newFiles?.includes(f));
    if (dataErr) return result(false, 3, 'формат результата', dataErr, `data:${f}`);
    if (/\.(js|mjs|cjs)$/.test(f)) {
      const r = await runCommand(`node --check "${f}"`, workdir, 30_000);
      if (r.code !== 0) return result(false, 3, 'синтаксис', r.output, `syntax:${f}`);
    } else if (SYNTAX[path.extname(f).toLowerCase()]) {
      const r = await runCommand(SYNTAX[path.extname(f).toLowerCase()]!.replace('{file}', `"${f}"`), workdir, 60_000);
      // утилиты языка нет на этом компьютере — синтаксис проверит сборка или тесты
      if (r.code !== 0 && !toolMissing(r)) return result(false, 3, 'синтаксис', r.output, `syntax:${f}`);
    } else if (/\.ya?ml$/i.test(f) && /^\t/m.test(readFileSync(abs, 'utf8'))) {
      return result(false, 3, 'синтаксис', `${f}: в YAML нельзя отступать табуляцией — только пробелами.`, `yaml-tab:${f}`);
    } else if (/\.json$/.test(f)) {
      try {
        JSON.parse(readFileSync(abs, 'utf8'));
      } catch (e) {
        return result(false, 3, 'синтаксис', `${f}: ${(e as Error).message}`, `json:${f}`);
      }
    }
  }

  // 3б. Стиль модулей: в проекте на import/export файл с module.exports не заработает — говорим сразу и по-человечески
  const styleErr = moduleStyleErrors(input.changedFiles, workdir, input.moduleSystem ?? null);
  if (styleErr) return result(false, 3, 'стиль модулей', styleErr, 'module-style');

  // 4–5. Линтер и типы: падаем только на ошибках, которых не было до прогона
  for (const [stage, key, name] of [[4, 'lint', 'линтер'], [5, 'typecheck', 'типы']] as const) {
    const cmd = commands[key];
    if (!cmd) continue;
    mark(`${name}: ${cmd.split(' ;; ').join(', ')}`);
    const r = await runCommand(cmd, workdir);
    if (r.code === 0) continue;
    const known = input.knownErrors?.[key];
    let fresh = known ? newErrors(errorLines(r.output), known) : null;
    if (fresh && fresh.length === 0) continue;
    // команда части проекта могла не попасть в проверку на старте — сравниваем с её же запуском на исходном состоянии
    const cmp = await judge(cmd, r);
    if (cmp?.preexisting) {
      notes.push(`${name}: падает так же, как до прогона (${cmp.before} шт.) — не вина задачи`);
      continue;
    }
    if (cmp && (!fresh || cmp.fresh.length < fresh.length)) fresh = cmp.fresh;
    if (fresh) {
      const was = known ? [...known.values()].reduce((a, b) => a + b, 0) : (cmp?.before ?? 0);
      return result(false, stage, name, `Новые ошибки (бывшие до прогона не считаются: ${was}):\n${fresh.slice(0, 40).join('\n')}`, `${key}:${errorKey(fresh.join('\n'))}`);
    }
    return result(false, stage, name, r.output, `${key}:${errorKey(r.output)}`);
  }

  // 6. Тесты задачи
  const testCmds = input.testCommands ?? taskTestCommands(task, commands);
  if (task.type === 'test') {
    if (testCmds.length === 0) {
      return result(false, 6, 'красный тест', 'В проекте нет команды запуска тестов — проверить новый тест нечем.', 'no-test-runner');
    }
    // «красный»: тест должен упасть, иначе он ничего нового не проверяет
    for (const cmd of testCmds) {
      const r = await runCommand(cmd, workdir);
      if (r.code === 0) {
        return result(false, 6, 'красный тест', `Новый тест проходит на текущем коде — значит, он не проверяет новое поведение.\n${r.output}`, 'test-not-red');
      }
      // Падение из-за того, что новой функции или файла ещё нет («does not provide an export», «Cannot find module»),
      // — это законный красный тест: код появится следующей задачей. Сломан тест, только если в нём самом синтаксическая ошибка.
      const broken = (await brokenTestFiles(task.accept.tests, workdir)) ?? foreignFramework(r.output);
      if (broken) return result(false, 6, 'красный тест', `Тест падает не из-за проверки, а из-за ошибки в самом тесте:\n${broken}`, 'test-broken');
      // красный «чужим» красным: команда падала так же и до прогона — новый тест не упал сам (или раннер его не видит)
      const cmp = await judge(cmd, r);
      if (cmp?.preexisting) {
        return result(false, 6, 'красный тест', `Команда тестов падает так же, как до прогона, — новый тест сам не упал (или раннер его не запускает). Проверь, что тест лежит там, где его найдёт раннер, и проверяет новое поведение.\n${r.output.slice(0, 1500)}`, 'test-not-red');
      }
    }
    return result(true, 6, 'красный тест', 'Тест падает на текущем коде — как и нужно.');
  }

  for (const cmd of testCmds) {
    mark(`тесты: ${cmd}`);
    const r = await runCommand(cmd, workdir);
    if (r.code === 0) continue;
    // тесты были красными и до прогона (прогон 20261020144005: go test бэкенда без go.sum) — задача ни при чём.
    // Но если команда запускает ровно тесты задачи (починить падающий тест — и есть задача), старое падение — её провал
    const strict = input.testsStrict ?? !input.testCommands;
    const cmp = strict ? null : await judge(cmd, r);
    if (cmp?.preexisting) {
      notes.push(`тесты: падают так же, как до прогона (${cmp.before} шт.) — не вина задачи`);
      continue;
    }
    const head = cmp?.fresh.length ? `Новые падения (бывшие до прогона не считаются: ${cmp.before}):\n${cmp.fresh.slice(0, 30).join('\n')}\n\n` : '';
    return result(false, 6, 'тесты', withHint(`${head}${r.output}`), `tests:${failingTests(cmp?.fresh.length ? cmp.fresh.join('\n') : r.output)}`);
  }
  for (const cmd of task.accept.commands) {
    mark(`команда: ${cmd}`);
    const r = await runCommand(cmd, workdir);
    if (r.code === 0) continue;
    // команда падает только на ошибках, которые были в проекте до прогона, — это не вина задачи
    const lines = errorLines(r.output);
    const known = new Map<string, number>();
    for (const m of [input.knownErrors?.typecheck, input.knownErrors?.lint]) for (const [k, n] of m ?? []) known.set(k, (known.get(k) ?? 0) + n);
    const wide = input.projectWide ? input.projectWide(cmd) : true;
    if (wide && lines.length && known.size && newErrors(lines, known).length === 0) continue;
    const cmp = wide ? await judge(cmd, r) : null;
    if (cmp?.preexisting) {
      notes.push(`команда ${cmd}: падает так же, как до прогона — не вина задачи`);
      continue;
    }
    const head = cmp?.fresh.length ? `Новые падения (бывшие до прогона не считаются: ${cmp.before}):\n${cmp.fresh.slice(0, 30).join('\n')}\n\n` : '';
    return result(false, 6, 'команды', withHint(`${head}Команда: ${cmd}\n${r.output}`), `cmd:${cmd}`);
  }

  return result(true, 6, 'тесты', notes.length ? `Все проверки пройдены. ${notes.join('; ')}.` : 'Все проверки пройдены.');
}

/**
 * Тест написан не под тест-раннер проекта (например, Jest-стиль в проекте на node:test):
 * падает с «describe/expect/require is not defined» — это сломанный тест, а не красный.
 */
function withHint(output: string): string {
  const hint = moduleHint(output);
  return hint ? `ПОДСКАЗКА: ${hint}\n\n${output}` : output;
}

/** Файлы кода (не тесты чужого стиля) должны говорить на «языке модулей» проекта. */
export function moduleStyleErrors(files: string[], workdir: string, system: 'esm' | 'cjs' | null): string | null {
  if (!system) return null;
  const bad: string[] = [];
  for (const f of files) {
    if (!/\.js$/.test(f)) continue; // .mjs/.cjs явно задают стиль сами
    const abs = path.join(workdir, f);
    if (!existsSync(abs)) continue;
    const code = readFileSync(abs, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    if (system === 'esm' && /\bmodule\.exports\b|\bexports\.\w+\s*=|\brequire\s*\(/.test(code)) bad.push(f);
    if (system === 'cjs' && /^\s*(export\s|import\s.+\sfrom\s)/m.test(code)) bad.push(f);
  }
  if (!bad.length) return null;
  const how =
    system === 'esm'
      ? 'Проект на ES-модулях: пиши `export function имя(...)` (или `export { имя }`) и подключай через `import`. module.exports и require здесь не работают.'
      : 'Проект на CommonJS: пиши `module.exports = { имя }` и подключай через `require`. import/export здесь не работают.';
  return `${bad.join(', ')}: стиль модулей не совпадает с проектом. ${how}`;
}

/** Понятная подсказка к частым ошибкам «не тот стиль модулей». */
export function moduleHint(output: string): string | null {
  if (/(module|exports|require) is not defined in ES module scope/.test(output)) {
    return 'Проект на ES-модулях: экспортируй через `export function …` или `export { … }`, подключай через `import`. module.exports и require здесь не работают.';
  }
  if (/Cannot use import statement outside a module|Unexpected token 'export'/.test(output)) {
    return 'Проект на CommonJS: экспортируй через `module.exports = { … }`, подключай через `require`. import/export здесь не работают.';
  }
  if (/does not provide an export named '(\w+)'/.test(output)) {
    const m = /does not provide an export named '(\w+)'/.exec(output)!;
    return `Тест импортирует «${m[1]}» по имени, а файл его так не экспортирует: нужен именованный экспорт \`export function ${m[1]}…\`.`;
  }
  return null;
}

export function foreignFramework(output: string): string | null {
  const m = /\b(require|describe|it|expect|test|jest|beforeEach|module|exports) is not defined\b/.exec(output);
  return m ? `Тест использует «${m[1]}», которого нет в этом проекте: пиши в стиле существующих тестов (тот же раннер и импорты).\n${output}` : null;
}

/** Синтаксическая проверка самих тестовых файлов (только JS — для остальных языков пропускаем). */
async function brokenTestFiles(files: string[], workdir: string): Promise<string | null> {
  for (const f of files) {
    if (!/\.(js|mjs|cjs)$/.test(f) || !existsSync(path.join(workdir, f))) continue;
    const r = await runCommand(`node --check "${f}"`, workdir, 30_000);
    if (r.code !== 0) return r.output;
  }
  return null;
}

export function taskTestCommands(task: Task, commands: ProjectCommands): string[] {
  if (task.accept.tests.length === 0) return [];
  if (commands.testFiles) return [commands.testFiles.replace('{files}', task.accept.tests.map((t) => `"${t}"`).join(' '))];
  return commands.test ? [commands.test] : [];
}

/** Строки с ошибками из вывода линтера или tsc. */
export function errorLines(output: string): string[] {
  // кроме слова error: go vet / go build («./main.go:10:2: undefined: x»), Kotlin («e: file.kt:3:1 …»)
  return output.split(/\r?\n/).filter((l) => l.trim().length > 0 && (/\berror\b/i.test(l) || /^\s*\S+\.go:\d+:\d+: /.test(l) || /^e: /.test(l)));
}

/**
 * Ключ ошибки: файл + код ошибки. Без номеров строк (правка выше по файлу их сдвигает)
 * и без текста — tsc печатает один и тот же тип по-разному между запусками
 * (порядок полей в «{ a; b }» меняется), и одна и та же ошибка выглядела бы новой.
 */
export function errorLineKey(line: string): string {
  const l = line.replace(/\\/g, '/');
  // TypeScript (TS2322) и C# (CS0103) печатают одинаково: файл(строка,колонка): error КОД
  const ts = /^\s*(.+?)\(\d+,\d+\): error ([A-Z]+\d+)/.exec(l);
  if (ts) return `${ts[1]!.trim()}|${ts[2]}`;
  const eslint = /^\s*(.+?):\d+:\d+.*?\berror\b.*?([\w@/-]+)\s*$/.exec(l);
  if (eslint) return `${eslint[1]!.trim()}|${eslint[2]}`;
  // остальные языки: убираем номера строк во всех видах — (10,5), [10,5], :10:5, :10:
  return l.replace(/\(\d+,\d+\)|\[\d+,\d+\]/g, '').replace(/:\d+:\d+/g, '').replace(/:\d+:/g, ':').replace(/\s+/g, ' ').trim();
}

/** Новые ошибки: сравниваем как мешки — если в файле было 2 ошибки TS2322, третья такая же считается новой. */
export function newErrors(lines: string[], known: Map<string, number>): string[] {
  const left = new Map(known);
  const fresh: string[] = [];
  for (const l of lines) {
    const k = errorLineKey(l);
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1);
    else fresh.push(l);
  }
  return fresh;
}

export function countErrorKeys(lines: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(errorLineKey(l), (m.get(errorLineKey(l)) ?? 0) + 1);
  return m;
}

/** Подпись упавших тестов: имена тестов без цифр времени — чтобы повтор узнавался. */
export function failingTests(output: string): string {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*(?:not ok \d+ - |✖ |FAIL |×\s)(.+?)(?:\s+\([\d.]+m?s\))?\s*$/.exec(line);
    if (m) names.add(m[1]!.trim());
  }
  return names.size ? [...names].sort().join('|') : errorKey(output);
}

function errorKey(output: string): string {
  const m = /(\w*Error[^\n]{0,120})/.exec(output);
  return (m?.[1] ?? firstLine(output)).replace(/\d+/g, '#');
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 160) ?? '';
}

/** Поля строки CSV с учётом кавычек. */
export function csvFields(line: string, sep: string): number {
  let n = 1;
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') i++;
      else q = !q;
    } else if (ch === sep && !q) n++;
  }
  return n;
}

/** Файл-результат: пустой новый файл, кривой CSV или JSONL — это провал, понятный исполнителю. */
export function dataFileProblem(file: string, abs: string, created: boolean): string | null {
  let text: string;
  try {
    text = readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
  if (created && !text.trim()) return `${file}: файл-результат пустой — запиши в него итог работы.`;
  if (/\.(csv|tsv)$/i.test(file)) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return null;
    const head = lines[0]!;
    const sep = /\.tsv$/i.test(file) ? '\t' : [';', ',', '\t'].sort((a, b) => head.split(b).length - head.split(a).length)[0]!;
    const want = csvFields(head, sep);
    const bad = lines.map((l, i) => ({ i: i + 1, n: csvFields(l, sep) })).filter((x) => x.n !== want);
    if (bad.length) return `${file}: в заголовке ${want} колонок, а в строках ${bad.slice(0, 5).map((b) => `${b.i} — ${b.n}`).join(', ')}${bad.length > 5 ? ` и ещё ${bad.length - 5}` : ''}. Сделай все строки с одинаковым числом колонок (значения с «${sep}» внутри бери в кавычки).`;
  }
  if (/\.jsonl$/i.test(file)) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    for (const [i, l] of lines.entries()) {
      try {
        JSON.parse(l);
      } catch (e) {
        return `${file}: строка ${i + 1} — не JSON: ${(e as Error).message}`;
      }
    }
  }
  return null;
}
