// Сравнение с исходным состоянием: задача отвечает только за НОВЫЕ падения.
//
// Любая команда проверки (тесты, сборка, типы, команды критерия) может быть красной ещё до прогона:
// нет go.sum, чужая сломанная форма, тест, который падал всегда. Раньше это знали только про линтер и типы,
// и то по выводу на старте. Теперь для любой упавшей команды программа один раз запускает её же на исходном
// состоянии (ветка прогона до первой задачи), запоминает результат и сравнивает падения «мешками»:
// у задачи провал, только если появилось то, чего не было.

import { errorLineKey, errorLines } from '../checks.ts';

export interface Outcome {
  code: number;
  output: string;
}

/** Строка вывода без путей рабочих копий, времени и номеров — чтобы одно и то же падение совпадало. */
export function normalizeLine(line: string, roots: string[] = []): string {
  let l = line.replace(/\\/g, '/');
  for (const r of roots) if (r) l = l.split(r.replace(/\\/g, '/')).join('');
  return l
    .replace(/[A-Za-z]:\/[^\s'"]*?\.agentyard\/worktrees\/[^/]+\//g, '')
    .replace(/\/[^\s'"]*?\.agentyard\/worktrees\/[^/]+\//g, '')
    .replace(/\(\d+(\.\d+)?m?s\)|\b\d+(\.\d+)?\s?m?s\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ключи падений: ошибки компилятора и линтера, упавшие тесты и пакеты, проблемы окружения. Ключ → строка для показа. */
export function failureKeys(output: string, roots: string[] = []): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (k: string, line: string) => out.set(k, [...(out.get(k) ?? []), line.trim()]);
  const lines = output.split(/\r?\n/);
  for (const raw of lines) {
    const line = normalizeLine(raw, roots);
    if (!line) continue;
    let m: RegExpExecArray | null;
    // Go: «--- FAIL: TestX», «FAIL	pkg [setup failed]», «FAIL	pkg	0.01s»
    if ((m = /^--- FAIL: (\S+)/.exec(line))) add(`gotest|${m[1]}`, raw);
    else if ((m = /^FAIL\s+(\S+)(\s|$)/.exec(line)) && m[1] !== 'FAIL') add(`gopkg|${m[1]}`, raw);
    // node:test / TAP: «not ok 3 - имя»
    else if ((m = /^not ok \d+ - (.+?)(\s#.*)?$/.exec(line))) add(`test|${m[1]}`, raw);
    // jest / vitest: «✕ имя», «× имя», «FAIL src/a.test.ts»
    else if ((m = /^[✕×✗]\s+(.+)$/.exec(line))) add(`test|${m[1]}`, raw);
    else if ((m = /^FAIL\s+(\S+\.(?:[cm]?[jt]sx?))\b/.exec(line))) add(`testfile|${m[1]}`, raw);
    // pytest: «FAILED tests/test_a.py::test_x - …», «ERROR tests/test_b.py»
    else if ((m = /^(FAILED|ERROR)\s+(\S+)/.exec(line))) add(`test|${m[2]}`, raw);
    // окружение
    else if ((m = /missing go\.sum entry for module providing package (\S+)/.exec(line))) add(`env|gosum|${m[1]}`, raw);
    else if ((m = /No module named '([^']+)'/.exec(line))) add(`env|pymodule|${m[1]}`, raw);
    else if ((m = /Missing script: "?([\w:-]+)"?/.exec(line))) add(`env|script|${m[1]}`, raw);
  }
  // ошибки компилятора и линтера — тем же ключом, что и при старте прогона (файл + код ошибки)
  for (const raw of errorLines(output)) {
    const line = normalizeLine(raw, roots);
    if (/missing go\.sum entry/.test(line)) continue;
    add(`err|${errorLineKey(line)}`, raw);
  }
  return out;
}

/** Подпись вывода без узнаваемых ключей: первые содержательные строки без чисел и путей. */
export function rawSignature(output: string, roots: string[] = []): string {
  return output
    .split(/\r?\n/)
    .map((l) => normalizeLine(l, roots).replace(/\d+/g, '#'))
    .filter((l) => l && !/^(>|npm (WARN|notice)|\[остановлено)/.test(l))
    .slice(0, 6)
    .join(' | ');
}

export interface Comparison {
  /** Падение целиком было и до прогона: задача ни при чём. */
  preexisting: boolean;
  /** Новые падения (строки для показа исполнителю). */
  fresh: string[];
  /** Сколько падений было до прогона. */
  before: number;
}

/**
 * Сравнить падение команды с её запуском на исходном состоянии. Мешками: если в файле было 2 ошибки TS2322,
 * третья такая же — новая. Без узнаваемых ключей — по подписи вывода.
 */
export function compareOutcomes(cur: Outcome, base: Outcome | null, roots: string[] = []): Comparison {
  if (cur.code === 0) return { preexisting: false, fresh: [], before: 0 };
  if (!base || base.code === 0) {
    const keys = failureKeys(cur.output, roots);
    return { preexisting: false, fresh: keys.size ? [...keys.values()].flat() : cur.output.split(/\r?\n/).filter(Boolean).slice(0, 40), before: 0 };
  }
  const now = failureKeys(cur.output, roots);
  const was = failureKeys(base.output, roots);
  const before = [...was.values()].reduce((n, l) => n + l.length, 0);
  if (now.size === 0 && was.size === 0) {
    const same = rawSignature(cur.output, roots) === rawSignature(base.output, roots);
    return { preexisting: same, fresh: same ? [] : cur.output.split(/\r?\n/).filter(Boolean).slice(0, 40), before: same ? 1 : 0 };
  }
  const fresh: string[] = [];
  for (const [k, lines] of now) {
    const left = (was.get(k) ?? []).length;
    if (lines.length > left) fresh.push(...lines.slice(left));
  }
  // команда упала, а ключи все прежние — но было ли падение вообще? (база упала тоже — значит, прежние)
  return { preexisting: fresh.length === 0, fresh, before };
}

/** Кэш запусков команд на исходном состоянии: каждая команда — один раз за прогон. */
export class BaselineRunner {
  private cache = new Map<string, Promise<Outcome>>();
  private runner: (cmd: string) => Promise<Outcome>;

  constructor(runner: (cmd: string) => Promise<Outcome>) {
    this.runner = runner;
  }

  of(cmd: string): Promise<Outcome> {
    let p = this.cache.get(cmd);
    if (!p) {
      p = this.runner(cmd).catch((e: Error) => ({ code: 1, output: `не удалось запустить на исходном состоянии: ${e.message}` }));
      this.cache.set(cmd, p);
    }
    return p;
  }

  /** Известный заранее результат (проверки на старте прогона) — без повторного запуска. */
  seed(cmd: string, outcome: Outcome): void {
    this.cache.set(cmd, Promise.resolve(outcome));
  }

  /** В части появились зависимости (поставили пакеты) — её команды на исходном состоянии ведут себя иначе. */
  invalidate(match: (cmd: string) => boolean): void {
    for (const k of [...this.cache.keys()]) if (match(k)) this.cache.delete(k);
  }
}
