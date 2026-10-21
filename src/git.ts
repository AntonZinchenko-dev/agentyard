// Работа с git: ветка сборки, рабочие копии задач (worktree), коммиты, bisect.
// Если папка не под git — делаем «теневой» репозиторий, чтобы откат работал всегда.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';

const run = promisify(execFile);

export async function git(cwd: string, args: string[], allowFail = false): Promise<string> {
  try {
    const { stdout } = await run('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout.trim();
  } catch (e) {
    if (allowFail) return '';
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args.join(' ')}: ${err.stderr?.trim() || err.message}`);
  }
}

/** Команда git как вопрос «да/нет» (по коду выхода). */
export async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await run('git', args, { cwd, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const AUTHOR =['-c', 'user.name=AgentYard', '-c', 'user.email=agentyard@localhost'];

export async function isRepo(dir: string): Promise<boolean> {
  return (await git(dir, ['rev-parse', '--is-inside-work-tree'], true)) === 'true';
}

/** Если git нет — инициализируем репозиторий, чтобы был откат. Возвращает true, если создали. */
export async function ensureRepo(dir: string): Promise<boolean> {
  if (await isRepo(dir)) return false;
  await git(dir, ['init', '-q']);
  await git(dir, ['add', '-A']);
  await git(dir, [...AUTHOR, 'commit', '-q', '--allow-empty', '-m', 'AgentYard: исходное состояние']);
  return true;
}

export async function currentBranch(dir: string): Promise<string> {
  return git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

/**
 * Незакоммиченные файлы (изменённые, новые, удалённые). Не через «status --porcelain»: git() обрезает
 * пробелы вывода, и у первой строки « M app/x» терялась буква пути.
 */
export async function dirtyFiles(dir: string): Promise<string[]> {
  const changed = (await git(dir, ['diff', '--name-only', 'HEAD'], true)).split('\n');
  const untracked = (await git(dir, ['ls-files', '--others', '--exclude-standard'], true)).split('\n');
  return [...new Set([...changed, ...untracked].map((f) => f.trim()).filter(Boolean))];
}

export async function hasUncommitted(dir: string): Promise<boolean> {
  return (await git(dir, ['status', '--porcelain'])).length > 0;
}

export class Workspace {
  readonly repo: string;
  readonly runId: string;
  readonly integration: string;
  readonly worktreeRoot: string;
  /** Папки частей проекта (monorepo), где в рабочих копиях нужны ссылки на node_modules и .venv ('' — корень). */
  depDirs: string[] = [''];

  constructor(repo: string, runId: string) {
    this.repo = repo;
    this.runId = runId;
    this.integration = `agentyard/run-${runId}`;
    this.worktreeRoot = path.join(repo, '.agentyard', 'worktrees');
  }

  /** Ветка сборки от текущего состояния проекта. Основная ветка не трогается. */
  async init(): Promise<void> {
    const base = await git(this.repo, ['rev-parse', 'HEAD']);
    await git(this.repo, ['branch', this.integration, base]);
    mkdirSync(this.worktreeRoot, { recursive: true });
    await this.ensureIgnored();
  }

  /**
   * Служебная папка .agentyard и ссылки на зависимости не должны попадать в коммиты.
   * Пишем в .git/info/exclude — это локальный .gitignore, сам проект не меняется.
   */
  private async ensureIgnored(): Promise<void> {
    const common = path.resolve(this.repo, await git(this.repo, ['rev-parse', '--git-common-dir']));
    const exclude = path.join(common, 'info', 'exclude');
    mkdirSync(path.dirname(exclude), { recursive: true });
    const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    // плюс то, что проверки сами создают в рабочей копии: кэш tsc, сборка, отчёты покрытия —
    // иначе это попадает в коммит и в diff для ревьюера (150 КБ tsconfig.tsbuildinfo вместо правки)
    const missing = ['.agentyard/', '/node_modules', 'node_modules', '/.venv', '.venv', '/venv', '*.tsbuildinfo', '.next/', '/dist', '/build', '/coverage', '.turbo/', '.cache/', '__pycache__/', '.pytest_cache/'].filter(
      (l) => !current.split(/\r?\n/).includes(l),
    );
    if (missing.length) appendFileSync(exclude, `\n${missing.join('\n')}\n`);
  }

  /** После сбоя: убрать рабочие копии и ветки задач этого прогона, оставшиеся от упавшего процесса. */
  async cleanupStale(): Promise<void> {
    const list = await git(this.repo, ['worktree', 'list', '--porcelain'], true);
    const prefix = `refs/heads/${this.integration}-`;
    let dir = '';
    const root = path.resolve(this.worktreeRoot);
    for (const line of list.split('\n')) {
      if (line.startsWith('worktree ')) dir = line.slice(9).trim();
      else if (line.startsWith('branch ') && line.slice(7).trim().startsWith(prefix)) await this.removeWorktree(dir);
      // копии без ветки (исходное состояние, вся ветка сборки) от упавшего процесса
      else if (line.trim() === 'detached' && path.resolve(dir).startsWith(root) && /^(base|integration)-/.test(path.basename(dir))) await this.removeWorktree(dir);
    }
    await git(this.repo, ['worktree', 'prune'], true);
    const branches = await git(this.repo, ['branch', '--list', `${this.integration}-*`, '--format=%(refname:short)'], true);
    for (const b of branches.split('\n').filter(Boolean)) await this.deleteBranch(b);
  }

  /** Рабочая копия задачи от актуального состояния ветки сборки. */
  async createTaskWorktree(taskId: string): Promise<{ dir: string; branch: string }> {
    const safe = taskId.replace(/[^\w.-]/g, '_');
    const branch = `${this.integration}-${safe}-${Date.now().toString(36)}`;
    const dir = path.join(this.worktreeRoot, `${safe}-${Date.now().toString(36)}`);
    await git(this.repo, ['worktree', 'add', '-q', '-b', branch, dir, this.integration]);
    this.linkDependencies(dir);
    return { dir, branch };
  }

  /**
   * В рабочей копии нет node_modules (они не в git). Даём ссылку на папку проекта,
   * чтобы тесты запускались без повторной установки. В Windows — junction, прав администратора не нужно.
   */
  linkDependencies(dir: string): void {
    // в проекте из частей (backend/ + web/) зависимости лежат в папке каждой части
    for (const sub of this.depDirs) {
      for (const name of ['node_modules', '.venv', 'venv']) {
        const src = path.join(this.repo, sub, name);
        const dst = path.join(dir, sub, name);
        if (existsSync(src) && !existsSync(dst) && existsSync(path.dirname(dst))) {
          try {
            symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
          } catch {
            // не получилось — тесты, которым нужны зависимости, упадут и покажут причину
          }
        }
      }
    }
  }

  /** Рабочая копия на заданном коммите (исходное состояние прогона — для сравнения падений). */
  async detachedWorktree(ref: string, label: string): Promise<string> {
    const dir = path.join(this.worktreeRoot, `${label}-${Date.now().toString(36)}`);
    await git(this.repo, ['worktree', 'add', '-q', '--detach', dir, ref]);
    this.linkDependencies(dir);
    return dir;
  }

  async commitAll(dir: string, message: string): Promise<boolean> {
    await git(dir, ['add', '-A']);
    if (!(await hasUncommitted(dir))) return false;
    await git(dir, [...AUTHOR, 'commit', '-q', '-m', message]);
    return true;
  }

  async diff(dir: string): Promise<string> {
    await git(dir, ['add', '-A']);
    return git(dir, ['diff', '--cached', '--stat', '-p', '--no-color']);
  }

  /** Отменить незакоммиченные изменения в рабочей копии. */
  async reset(dir: string): Promise<void> {
    await git(dir, ['reset', '-q', '--hard']);
    await git(dir, ['clean', '-qfd']);
  }

  /**
   * Перенести задачу поверх свежей ветки сборки и влить её.
   * Возвращает null при успехе или текст конфликта.
   */
  async rebaseOntoIntegration(dir: string): Promise<string | null> {
    try {
      await git(dir, [...AUTHOR, 'rebase', this.integration]);
      return null;
    } catch (e) {
      const msg = (e as Error).message;
      await git(dir, ['rebase', '--abort'], true);
      return msg;
    }
  }

  /** Быстрое слияние ветки задачи в ветку сборки (после успешного rebase). */
  async fastForwardIntegration(branch: string): Promise<void> {
    // ветка сборки нигде не выгружена, поэтому двигаем её указатель напрямую
    const head = await git(this.repo, ['rev-parse', branch]);
    const base = await git(this.repo, ['rev-parse', this.integration]);
    if (!(await gitOk(this.repo, ['merge-base', '--is-ancestor', base, head]))) {
      throw new Error('Ветка задачи не продолжает ветку сборки');
    }
    await git(this.repo, ['update-ref', `refs/heads/${this.integration}`, head, base]);
  }

  /** Изменения задачи относительно ветки сборки — это видит ревьюер. */
  async diffAgainstIntegration(dir: string, paths: string[] = []): Promise<string> {
    return git(dir, ['diff', '--no-color', `${this.integration}...HEAD`, ...(paths.length ? ['--', ...paths] : [])]);
  }

  async sha(ref: string, cwd = this.repo): Promise<string> {
    return git(cwd, ['rev-parse', ref]);
  }

  async deleteBranch(branch: string): Promise<void> {
    await git(this.repo, ['branch', '-D', branch], true);
  }

  async removeWorktree(dir: string): Promise<void> {
    await git(this.repo, ['worktree', 'remove', '--force', dir], true);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  /** Рабочая копия всей ветки сборки — для полного прогона тестов и bisect. */
  async integrationWorktree(): Promise<string> {
    const dir = path.join(this.worktreeRoot, `integration-${Date.now().toString(36)}`);
    await git(this.repo, ['worktree', 'add', '-q', '--detach', dir, this.integration]);
    this.linkDependencies(dir);
    return dir;
  }

  /** Список коммитов задач в ветке сборки (от старых к новым). */
  async taskCommits(baseRef: string): Promise<{ sha: string; subject: string }[]> {
    const out = await git(this.repo, ['log', '--reverse', '--format=%H%x09%s', `${baseRef}..${this.integration}`]);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, subject] = l.split('\t');
        return { sha: sha!, subject: subject ?? '' };
      });
  }

  /** Откатить коммит задачи в ветке сборки (новым коммитом, история сохраняется). */
  async revertInIntegration(sha: string): Promise<void> {
    const dir = await this.integrationWorktree();
    try {
      await git(dir, ['checkout', '-q', '-B', `${this.integration}-revert`, this.integration]);
      await git(dir, [...AUTHOR, 'revert', '--no-edit', sha]);
      const head = await git(dir, ['rev-parse', 'HEAD']);
      await git(this.repo, ['update-ref', `refs/heads/${this.integration}`, head]);
    } finally {
      await this.removeWorktree(dir);
      await git(this.repo, ['branch', '-D', `${this.integration}-revert`], true);
    }
  }
}

/** Двоичный поиск первого «плохого» коммита: как лампочка в гирлянде. */
export async function bisectFirstBad(
  commits: string[],
  isGood: (sha: string) => Promise<boolean>,
): Promise<string | null> {
  let lo = 0;
  let hi = commits.length - 1;
  let bad: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (await isGood(commits[mid]!)) {
      lo = mid + 1;
    } else {
      bad = commits[mid]!;
      hi = mid - 1;
    }
  }
  return bad;
}
