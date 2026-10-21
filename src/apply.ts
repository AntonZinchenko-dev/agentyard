// Доставка результата в проект: ветку прогона вливаем в текущую ветку пользователя.
// До этого шага изменения живут только в ветке agentyard/run-…, и Docker, dev-сервер и редактор их не видят.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dirtyFiles, git, gitOk } from './git.ts';

const AUTHOR = ['-c', 'user.name=AgentYard', '-c', 'user.email=agentyard@localhost'];

/** Что известно о прогоне для доставки (пишется в папку прогона как run.json). */
export interface RunMeta {
  runId: string;
  branch: string;
  /** Коммит, от которого начинался прогон. */
  base: string;
  /** Ветка пользователя на момент старта — туда и доставляем. */
  target: string;
  done: string[];
  human: { id: string; why: string }[];
  applied?: { from: string; to: string; at: string; mode: 'ff' | 'merge' };
  /** Задача с доски, из которой взята цель. */
  issue?: { provider: string; id: string; key: string; url: string; title: string };
  /** Что отправлено наружу: ветка, PR/MR, комментарий в задачу. */
  published?: { pushed?: string; pr?: string; commented?: string; at: string };
}

export interface ChangedFile {
  file: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  added: number;
  removed: number;
}

export function runDirOf(repo: string, runId: string): string {
  if (!/^[\w-]+$/.test(runId)) throw new Error('плохой id прогона');
  return path.join(path.resolve(repo), '.agentyard', 'runs', runId);
}

export function readMeta(repo: string, runId: string): RunMeta | null {
  const f = path.join(runDirOf(repo, runId), 'run.json');
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as RunMeta) : null;
}

export function writeMeta(repo: string, meta: RunMeta): void {
  writeFileSync(path.join(runDirOf(repo, meta.runId), 'run.json'), JSON.stringify(meta, null, 2));
}

/** Что прогон изменил относительно точки старта. */
export async function changedFiles(repo: string, meta: Pick<RunMeta, 'base' | 'branch'>): Promise<ChangedFile[]> {
  const range = `${meta.base}..${meta.branch}`;
  const status = await git(repo, ['diff', '--name-status', '-M', range]);
  const nums = await git(repo, ['diff', '--numstat', '-M', range]);
  const counts = new Map<string, [number, number]>();
  for (const l of nums.split('\n').filter(Boolean)) {
    const [a, r, ...f] = l.split('\t');
    counts.set(f.at(-1)!.replace(/^.*=> /, '').replace(/[{}]/g, ''), [Number(a) || 0, Number(r) || 0]);
  }
  return status
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [code, ...files] = l.split('\t');
      const file = files.at(-1)!;
      const st = code!.startsWith('A') ? 'added' : code!.startsWith('D') ? 'deleted' : code!.startsWith('R') ? 'renamed' : 'modified';
      const [added, removed] = counts.get(file) ?? [0, 0];
      return { file, status: st, added, removed } as ChangedFile;
    });
}

export async function runDiff(repo: string, meta: Pick<RunMeta, 'base' | 'branch'>, maxChars = 200_000): Promise<string> {
  const d = await git(repo, ['diff', '--no-color', '-M', `${meta.base}..${meta.branch}`]);
  return d.length > maxChars ? `${d.slice(0, maxChars)}\n… (обрезано)` : d;
}

export interface ApplyResult {
  ok: boolean;
  mode?: 'ff' | 'merge' | 'nothing';
  files?: string[];
  message: string;
}

/**
 * Влить ветку прогона в ветку, на которой пользователь был при старте.
 * Свои незакоммиченные правки пользователя не трогаем: если они в тех же файлах — отказ с объяснением.
 */
export async function applyRun(repo: string, runId: string): Promise<ApplyResult> {
  const meta = readMeta(repo, runId);
  if (!meta) return { ok: false, message: 'У прогона нет run.json — он не дошёл до конца.' };
  if (meta.applied) return { ok: true, mode: 'nothing', message: 'Уже применено.' };
  const changes = await changedFiles(repo, meta);
  if (changes.length === 0) return { ok: true, mode: 'nothing', message: 'Прогон ничего не изменил — применять нечего.' };

  const head = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head === 'HEAD') return { ok: false, message: 'В проекте не выбрана ветка (detached HEAD) — переключись на свою ветку и повтори.' };
  if (head !== meta.target) {
    return { ok: false, message: `Прогон делался от ветки ${meta.target}, а сейчас выбрана ${head}. Переключись на ${meta.target} (git checkout ${meta.target}) и повтори.` };
  }
  const dirty = await dirtyFiles(repo);
  const touched = new Set(changes.map((c) => c.file));
  const clash = dirty.filter((f) => touched.has(f));
  if (clash.length) {
    return { ok: false, message: `Эти файлы ты менял сам и не закоммитил, а прогон их тоже поменял: ${clash.join(', ')}. Закоммить или отмени свои правки и повтори.` };
  }

  const from = await git(repo, ['rev-parse', 'HEAD']);
  let mode: 'ff' | 'merge' = 'ff';
  if (await gitOk(repo, ['merge-base', '--is-ancestor', 'HEAD', meta.branch])) {
    await git(repo, ['merge', '--ff-only', '-q', meta.branch]);
  } else {
    mode = 'merge';
    try {
      await git(repo, [...AUTHOR, 'merge', '--no-edit', '-q', '-m', `AgentYard: результат прогона ${runId}`, meta.branch]);
    } catch (e) {
      const conflicts = (await git(repo, ['diff', '--name-only', '--diff-filter=U'], true)).split('\n').filter(Boolean);
      await git(repo, ['merge', '--abort'], true);
      return { ok: false, message: `Конфликт с изменениями, сделанными после старта прогона${conflicts.length ? `: ${conflicts.join(', ')}` : ''}. Ничего не изменено. ${(e as Error).message.slice(0, 200)}` };
    }
  }
  const to = await git(repo, ['rev-parse', 'HEAD']);
  meta.applied = { from, to, at: new Date().toISOString(), mode };
  writeMeta(repo, meta);
  return { ok: true, mode, files: [...touched], message: `Применено в ветку ${head}: ${touched.size} файл(ов). Отменить можно кнопкой «Отменить применение».` };
}

/**
 * Откатить применённый прогон. Если после него в ветке ничего не делали — просто возвращаем ветку назад
 * (как будто прогона не было). Если были свои коммиты — делаем обратный коммит только на изменения прогона,
 * твоя работа после него остаётся. Незакоммиченные правки в других файлах сохраняются.
 */
export async function unapplyRun(repo: string, runId: string): Promise<ApplyResult> {
  const meta = readMeta(repo, runId);
  if (!meta?.applied) return { ok: false, message: 'Этот прогон не применялся — откатывать нечего.' };
  const { from, to } = meta.applied;
  const head = await git(repo, ['rev-parse', 'HEAD']);
  if (head === to) {
    try {
      await git(repo, ['reset', '-q', '--keep', from]);
    } catch (e) {
      return { ok: false, message: `Не получилось откатить: ${(e as Error).message.slice(0, 300)}` };
    }
    delete meta.applied;
    writeMeta(repo, meta);
    return { ok: true, message: 'Откачено: проект вернулся к состоянию до прогона.' };
  }
  if (!(await gitOk(repo, ['merge-base', '--is-ancestor', to, 'HEAD']))) {
    return { ok: false, message: 'Применённых изменений этого прогона уже нет в текущей ветке (переключил ветку или переписал историю) — откатывать нечего.' };
  }
  // после применения были другие коммиты: обратный коммит на разницу «до прогона → после прогона»
  const diff = await git(repo, ['diff', '--binary', to, from]);
  if (!diff.trim()) return { ok: false, message: 'Прогон ничего не менял — откатывать нечего.' };
  const touched = (await git(repo, ['diff', '--name-only', from, to])).split('\n').filter(Boolean);
  const dirty = await dirtyFiles(repo);
  const clash = dirty.filter((f) => touched.includes(f));
  if (clash.length) return { ok: false, message: `Сначала закоммить или отмени свои незакоммиченные правки в: ${clash.join(', ')}.` };
  try {
    await gitApply(repo, diff);
  } catch (e) {
    // эти файлы были чистыми — возвращаем их как было, без следов неудачной попытки
    await git(repo, ['reset', '-q', '--', ...touched], true);
    await git(repo, ['checkout', '-q', '--', ...touched], true);
    return { ok: false, message: `Откатить автоматически нельзя: после прогона эти же места меняли ещё раз. ${(e as Error).message.slice(0, 200)}` };
  }
  await git(repo, ['add', '--', ...touched]);
  await git(repo, [...AUTHOR, 'commit', '-q', '-m', `AgentYard: откат прогона ${runId}`]);
  delete meta.applied;
  writeMeta(repo, meta);
  return { ok: true, message: `Откачено обратным коммитом: изменения прогона убраны (${touched.length} файл(ов)), твои коммиты после него остались.` };
}

function gitApply(repo: string, patch: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['apply', '--3way', '--whitespace=nowarn', '-'], { cwd: repo, windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `git apply: код ${code}`))));
    p.stdin.end(patch.endsWith('\n') ? patch : `${patch}\n`);
  });
}
