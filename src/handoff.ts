// Задача у человека: своя рабочая копия от ветки прогона, файлы открываются в редакторе,
// после сохранения программа проверяет правку, вливает её и агенты идут дальше по цепочке.
// Рабочая копия — отдельная ветка agentyard/human-<прогон>-<задача>: продолжение прогона её не трогает.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { dirtyFiles, git, Workspace } from './git.ts';
import { matchFiles } from './replicate.ts';
import { listFiles } from './tools/fs.ts';
import type { Task } from './types.ts';

const safe = (id: string) => id.replace(/[^\w.-]/g, '_');

export function humanBranch(runId: string, taskId: string): string {
  return `agentyard/human-${runId}-${safe(taskId)}`;
}

export function humanDir(repo: string, runId: string, taskId: string): string {
  return path.join(path.resolve(repo), '.agentyard', 'human', `${runId}-${safe(taskId)}`);
}

export interface Handoff {
  dir: string;
  branch: string;
  /** Пути файлов задачи внутри рабочей копии (для редактора). */
  files: string[];
  /** Рабочая копия создана сейчас (false — продолжаем начатую). */
  created: boolean;
}

/** Рабочая копия для ручной правки: от актуальной ветки прогона, с node_modules проекта. */
export async function prepareHandoff(repo: string, runId: string, taskId: string, files: string[]): Promise<Handoff> {
  const dir = humanDir(repo, runId, taskId);
  const branch = humanBranch(runId, taskId);
  let created = false;
  if (!existsSync(path.join(dir, '.git'))) {
    mkdirSync(path.dirname(dir), { recursive: true });
    await git(repo, ['worktree', 'prune'], true);
    const exists = (await git(repo, ['branch', '--list', branch], true)).trim().length > 0;
    if (exists) await git(repo, ['worktree', 'add', '-q', dir, branch]);
    else await git(repo, ['worktree', 'add', '-q', '-b', branch, dir, `agentyard/run-${runId}`]);
    new Workspace(repo, runId).linkDependencies(dir);
    created = true;
  }
  const list = files.filter((f) => !f.includes('*')).map((f) => path.join(dir, f));
  return { dir, branch, files: list, created };
}

/** Что человек поменял в рабочей копии (незакоммиченное). */
export async function handoffChanges(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  return (await dirtyFiles(dir)).filter((f) => !/^(node_modules|\.venv|venv)(\/|$)/.test(f));
}

/** Убрать рабочую копию и её ветку (правка влита или человек передумал). */
export async function dropHandoff(repo: string, runId: string, taskId: string): Promise<void> {
  const dir = humanDir(repo, runId, taskId);
  await git(repo, ['worktree', 'remove', '--force', dir], true);
  await git(repo, ['worktree', 'prune'], true);
  await git(repo, ['branch', '-D', humanBranch(runId, taskId)], true);
}

/** Есть ли программа в PATH (where / which). */
function onPath(cmd: string): boolean {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { windowsHide: true, encoding: 'utf8' });
  return r.status === 0 && !!r.stdout.trim();
}

/**
 * Открыть файлы в редакторе: VS Code (если стоит) — сразу папкой и файлами; иначе — программа по умолчанию.
 * AGENTYARD_EDITOR задаёт свою команду; «none» — ничего не открывать (тесты).
 */
export function openInEditor(dir: string, files: string[]): { editor: string; ok: boolean } {
  const custom = process.env.AGENTYARD_EDITOR;
  if (custom === 'none') return { editor: 'none', ok: true };
  const targets = files.filter((f) => existsSync(f));
  const run = (cmd: string, args: string[], shell = false) => {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, shell });
    p.on('error', () => undefined);
    p.unref();
  };
  try {
    if (custom) {
      run(custom, [dir, ...targets], true);
      return { editor: custom, ok: true };
    }
    const codeWin = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd') : '';
    if (process.platform === 'win32' && codeWin && existsSync(codeWin)) {
      run(`"${codeWin}"`, ['-n', `"${dir}"`, ...targets.map((f) => `"${f}"`)], true);
      return { editor: 'VS Code', ok: true };
    }
    if (onPath('code')) {
      run('code', ['-n', dir, ...targets], process.platform === 'win32');
      return { editor: 'VS Code', ok: true };
    }
    if (process.platform === 'win32') {
      // файлов нет — открываем папку в проводнике (Блокнот папку не откроет)
      if (!targets.length) {
        run('explorer.exe', [dir]);
        return { editor: 'Проводник', ok: true };
      }
      for (const f of targets) run('notepad.exe', [f]);
      return { editor: 'Блокнот', ok: true };
    }
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    for (const f of targets.length ? targets : [dir]) run(opener, [f]);
    return { editor: opener, ok: true };
  } catch {
    return { editor: '', ok: false };
  }
}

/**
 * Правка человека в файле-образце как заплатки «найди — замени» (по кускам diff) —
 * чтобы программа повторила её во всех однотипных файлах, как после агента.
 */
export function patchesFromDiff(file: string, diff: string): { file: string; search: string; replace: string }[] {
  const out: { file: string; search: string; replace: string }[] = [];
  let old: string[] | null = null;
  let neu: string[] = [];
  const flush = () => {
    if (old && (old.join('\n') !== neu.join('\n'))) out.push({ file, search: old.join('\n'), replace: neu.join('\n') });
    old = null;
    neu = [];
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      flush();
      old = [];
      continue;
    }
    if (old === null || line.startsWith('\\')) continue;
    if (line.startsWith('-')) old.push(line.slice(1));
    else if (line.startsWith('+')) neu.push(line.slice(1));
    else if (line.startsWith(' ')) {
      old.push(line.slice(1));
      neu.push(line.slice(1));
    }
  }
  flush();
  return out.filter((p) => p.search.trim());
}

/**
 * Какие файлы открыть человеку. У задачи их может не быть (проверочная часть «убедиться, что…») —
 * тогда берём пути и шаблоны из её текста и команд, потом файлы её родителя и соседних частей.
 */
export function handoffFiles(repo: string, t: Task, all: Task[]): string[] {
  const own = [...new Set([...t.files, ...(t.newFiles ?? [])])].filter((f) => !f.includes('*'));
  if (own.length) return own;
  const files = existsSync(repo) ? listFiles(repo) : [];
  const text = [t.title, t.brief, ...t.accept.commands, ...t.files].join('\n');
  const found = new Set<string>();
  for (const m of text.matchAll(/[\w.@()[\]*-]+(?:\/[\w.@()[\]*-]+)+\.[A-Za-z]{1,5}\b/g)) {
    const p = m[0];
    if (p.includes('*')) for (const f of matchFiles(p, files).slice(0, 8)) found.add(f);
    else if (files.includes(p)) found.add(p);
  }
  if (found.size) return [...found].slice(0, 8);
  const byId = new Map(all.map((x) => [x.id, x]));
  const near = [t.parent ? byId.get(t.parent) : undefined, ...(t.parent ? (byId.get(t.parent)?.children ?? []).map((c) => byId.get(c)) : [])].filter((x): x is Task => !!x);
  return [...new Set(near.flatMap((x) => x.files).filter((f) => !f.includes('*')))].slice(0, 8);
}
