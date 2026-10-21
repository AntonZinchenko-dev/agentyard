// Интеграции: задачи из досок (GitHub Issues, GitLab, Jira, Trello, YouTrack) как цель прогона,
// итог прогона — комментарием обратно в задачу, ветка прогона — push и PR/MR.
// Токены хранятся только у пользователя: ~/.agentyard/integrations.json. Модель их не видит никогда:
// адреса и токены подставляет программа, а не агент.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './git.ts';

export type ProviderId = 'github' | 'gitlab' | 'jira' | 'trello' | 'youtrack';

export interface IntegrationsConfig {
  github?: { token: string; repo?: string; api?: string };
  gitlab?: { token: string; url?: string; project?: string };
  jira?: { url: string; token: string; email?: string; jql?: string };
  trello?: { key: string; token: string; boardId: string; list?: string };
  youtrack?: { url: string; token: string; query?: string };
}

export interface Issue {
  provider: ProviderId;
  /** Идентификатор для API (номер, ключ, id карточки). */
  id: string;
  /** Как показать человеку: #12, PROJ-34, «карточка». */
  key: string;
  title: string;
  body: string;
  url: string;
}

export const PROVIDER_NAMES: Record<ProviderId, string> = { github: 'GitHub', gitlab: 'GitLab', jira: 'Jira', trello: 'Trello', youtrack: 'YouTrack' };

export function configPath(): string {
  return process.env.AGENTYARD_INTEGRATIONS ?? path.join(os.homedir(), '.agentyard', 'integrations.json');
}

export function loadConfig(file = configPath()): IntegrationsConfig {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as IntegrationsConfig) : {};
  } catch {
    return {};
  }
}

/** Сохранить настройки провайдера. Пустой токен — оставить прежний (в окне токены не показываются). null — отключить. */
export function saveProvider(provider: ProviderId, settings: Record<string, string> | null, file = configPath()): IntegrationsConfig {
  const cfg = loadConfig(file) as Record<string, Record<string, string> | undefined>;
  if (settings === null) delete cfg[provider];
  else {
    const prev = cfg[provider] ?? {};
    const next: Record<string, string> = { ...prev };
    for (const [k, v] of Object.entries(settings)) {
      const val = String(v ?? '').trim();
      if (/token|key/i.test(k) && !val) continue; // пустое поле секрета — не стирать сохранённый
      if (val) next[k] = val;
      else delete next[k];
    }
    cfg[provider] = next;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2));
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows: права наследуются от профиля пользователя */
  }
  return cfg as IntegrationsConfig;
}

/** Настройки для окна: секреты заменены на «задан». */
export function publicConfig(cfg: IntegrationsConfig): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [p, s] of Object.entries(cfg) as [string, Record<string, string>][]) {
    out[p] = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, /token|key/i.test(k) ? (v ? '••• задан' : '') : v]));
  }
  return out;
}

// ---------- HTTP ----------

async function call<T>(url: string, init: RequestInit & { headers?: Record<string, string> }, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'AgentYard', accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } });
  } catch (e) {
    throw new Error(`${what}: сервис недоступен (${(e as Error).message})`);
  }
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? ' — проверь токен и его права' : res.status === 404 ? ' — проверь адрес, проект или репозиторий' : '';
    throw new Error(`${what}: ${res.status}${hint}. ${text.slice(0, 200)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

// ---------- git: откуда репозиторий ----------

/** owner/repo и хост из адреса origin (git@github.com:o/r.git, https://gitlab.company.ru/g/sub/r.git). */
export function parseRemote(url: string): { host: string; path: string } | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/]+@)([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { host: m[1]!, path: m[2]! } : null;
}

export async function originOf(repo: string): Promise<{ host: string; path: string; url: string } | null> {
  const url = await git(repo, ['remote', 'get-url', 'origin'], true);
  const p = url ? parseRemote(url) : null;
  return p ? { ...p, url } : null;
}

async function githubRepo(cfg: NonNullable<IntegrationsConfig['github']>, repo?: string): Promise<string> {
  if (cfg.repo) return cfg.repo;
  const o = repo ? await originOf(repo) : null;
  if (o && /github/i.test(o.host)) return o.path;
  throw new Error('GitHub: не знаю репозиторий — укажи owner/repo в настройках или добавь в проект remote origin на GitHub.');
}

async function gitlabProject(cfg: NonNullable<IntegrationsConfig['gitlab']>, repo?: string): Promise<string> {
  if (cfg.project) return encodeURIComponent(cfg.project);
  const o = repo ? await originOf(repo) : null;
  if (o) return encodeURIComponent(o.path);
  throw new Error('GitLab: не знаю проект — укажи группа/проект в настройках или добавь remote origin.');
}

// ---------- задачи ----------

/** Описание задачи Jira v3 (документ ADF) → обычный текст. */
export function adfText(node: unknown): string {
  if (!node || typeof node !== 'object') return typeof node === 'string' ? node : '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === 'text') return n.text ?? '';
  const inner = (n.content ?? []).map(adfText).join(n.type === 'doc' ? '\n' : '');
  return ['paragraph', 'heading', 'listItem', 'codeBlock'].includes(n.type ?? '') ? `${inner}\n` : inner;
}

export async function listIssues(provider: ProviderId, cfg: IntegrationsConfig, repo?: string): Promise<Issue[]> {
  switch (provider) {
    case 'github': {
      const c = cfg.github!;
      const api = (c.api ?? 'https://api.github.com').replace(/\/$/, '');
      const r = await githubRepo(c, repo);
      const items = await call<{ number: number; title: string; body: string | null; html_url: string; pull_request?: unknown }[]>(
        `${api}/repos/${r}/issues?state=open&per_page=30`,
        { headers: { authorization: `Bearer ${c.token}`, accept: 'application/vnd.github+json' } },
        'GitHub',
      );
      return items.filter((i) => !i.pull_request).map((i) => ({ provider, id: String(i.number), key: `#${i.number}`, title: i.title, body: i.body ?? '', url: i.html_url }));
    }
    case 'gitlab': {
      const c = cfg.gitlab!;
      const base = (c.url ?? 'https://gitlab.com').replace(/\/$/, '');
      const p = await gitlabProject(c, repo);
      const items = await call<{ iid: number; title: string; description: string | null; web_url: string }[]>(`${base}/api/v4/projects/${p}/issues?state=opened&per_page=30`, { headers: { 'private-token': c.token } }, 'GitLab');
      return items.map((i) => ({ provider, id: String(i.iid), key: `#${i.iid}`, title: i.title, body: i.description ?? '', url: i.web_url }));
    }
    case 'jira': {
      const c = cfg.jira!;
      const base = c.url.replace(/\/$/, '');
      const jql = c.jql || 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
      const headers = jiraAuth(c);
      type J = { issues: { key: string; fields: { summary: string; description: unknown } }[] };
      let r: J;
      try {
        r = await call<J>(`${base}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=30&fields=summary,description`, { headers }, 'Jira');
      } catch (e) {
        // Jira Server / Data Center: старый адрес поиска
        if (!/: (404|405|410)/.test((e as Error).message)) throw e;
        r = await call<J>(`${base}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=30&fields=summary,description`, { headers }, 'Jira');
      }
      return r.issues.map((i) => ({ provider, id: i.key, key: i.key, title: i.fields.summary, body: adfText(i.fields.description).trim(), url: `${base}/browse/${i.key}` }));
    }
    case 'trello': {
      const c = cfg.trello!;
      const auth = `key=${encodeURIComponent(c.key)}&token=${encodeURIComponent(c.token)}`;
      const base = process.env.AGENTYARD_TRELLO_API ?? 'https://api.trello.com';
      let cards = await call<{ id: string; name: string; desc: string; shortUrl: string; idList: string; closed?: boolean }[]>(`${base}/1/boards/${c.boardId}/cards?fields=name,desc,shortUrl,idList,closed&${auth}`, {}, 'Trello');
      if (c.list) {
        const lists = await call<{ id: string; name: string }[]>(`${base}/1/boards/${c.boardId}/lists?fields=name&${auth}`, {}, 'Trello');
        const ids = new Set(lists.filter((l) => l.name.toLowerCase().includes(c.list!.toLowerCase())).map((l) => l.id));
        cards = cards.filter((x) => ids.has(x.idList));
      }
      return cards.filter((x) => !x.closed).slice(0, 30).map((x) => ({ provider, id: x.id, key: 'карточка', title: x.name, body: x.desc, url: x.shortUrl }));
    }
    case 'youtrack': {
      const c = cfg.youtrack!;
      const base = c.url.replace(/\/$/, '');
      const q = c.query || 'for: me #Unresolved';
      const items = await call<{ idReadable: string; summary: string; description: string | null }[]>(
        `${base}/api/issues?query=${encodeURIComponent(q)}&fields=idReadable,summary,description&$top=30`,
        { headers: { authorization: `Bearer ${c.token}` } },
        'YouTrack',
      );
      return items.map((i) => ({ provider, id: i.idReadable, key: i.idReadable, title: i.summary, body: i.description ?? '', url: `${base}/issue/${i.idReadable}` }));
    }
  }
}

function jiraAuth(c: NonNullable<IntegrationsConfig['jira']>): Record<string, string> {
  // Jira Cloud: email + API-токен (Basic); Server/DC: персональный токен (Bearer)
  return c.email ? { authorization: `Basic ${Buffer.from(`${c.email}:${c.token}`).toString('base64')}` } : { authorization: `Bearer ${c.token}` };
}

/** Задачи со всех подключённых досок; ошибка одной доски не мешает остальным. */
export async function allIssues(cfg: IntegrationsConfig, repo?: string): Promise<{ issues: Issue[]; errors: { provider: ProviderId; error: string }[] }> {
  const providers = (Object.keys(PROVIDER_NAMES) as ProviderId[]).filter((p) => cfg[p]);
  const res = await Promise.all(providers.map((p) => listIssues(p, cfg, repo).then((issues) => ({ p, issues, error: '' })).catch((e: Error) => ({ p, issues: [] as Issue[], error: e.message }))));
  return { issues: res.flatMap((r) => r.issues), errors: res.filter((r) => r.error).map((r) => ({ provider: r.p, error: r.error })) };
}

export async function commentIssue(issue: Pick<Issue, 'provider' | 'id'>, text: string, cfg: IntegrationsConfig, repo?: string): Promise<void> {
  switch (issue.provider) {
    case 'github': {
      const c = cfg.github!;
      const api = (c.api ?? 'https://api.github.com').replace(/\/$/, '');
      await call(`${api}/repos/${await githubRepo(c, repo)}/issues/${issue.id}/comments`, { method: 'POST', body: JSON.stringify({ body: text }), headers: { authorization: `Bearer ${c.token}`, accept: 'application/vnd.github+json' } }, 'GitHub');
      return;
    }
    case 'gitlab': {
      const c = cfg.gitlab!;
      const base = (c.url ?? 'https://gitlab.com').replace(/\/$/, '');
      await call(`${base}/api/v4/projects/${await gitlabProject(c, repo)}/issues/${issue.id}/notes`, { method: 'POST', body: JSON.stringify({ body: text }), headers: { 'private-token': c.token } }, 'GitLab');
      return;
    }
    case 'jira': {
      const c = cfg.jira!;
      await call(`${c.url.replace(/\/$/, '')}/rest/api/2/issue/${encodeURIComponent(issue.id)}/comment`, { method: 'POST', body: JSON.stringify({ body: text }), headers: jiraAuth(c) }, 'Jira');
      return;
    }
    case 'trello': {
      const c = cfg.trello!;
      const base = process.env.AGENTYARD_TRELLO_API ?? 'https://api.trello.com';
      await call(`${base}/1/cards/${issue.id}/actions/comments?text=${encodeURIComponent(text)}&key=${encodeURIComponent(c.key)}&token=${encodeURIComponent(c.token)}`, { method: 'POST' }, 'Trello');
      return;
    }
    case 'youtrack': {
      const c = cfg.youtrack!;
      await call(`${c.url.replace(/\/$/, '')}/api/issues/${encodeURIComponent(issue.id)}/comments?fields=id`, { method: 'POST', body: JSON.stringify({ text }), headers: { authorization: `Bearer ${c.token}` } }, 'YouTrack');
      return;
    }
  }
}

// ---------- git: push и PR/MR ----------

export async function pushBranch(repo: string, branch: string): Promise<string> {
  if (!(await git(repo, ['remote', 'get-url', 'origin'], true))) throw new Error('У проекта нет remote origin — отправлять некуда. Добавь: git remote add origin <адрес>.');
  try {
    await git(repo, ['push', '-u', 'origin', `${branch}:${branch}`]);
  } catch (e) {
    throw new Error(`git push не прошёл: ${(e as Error).message.slice(0, 300)}. Проверь доступ к репозиторию (вход в git на этом компьютере).`);
  }
  return branch;
}

/** PR (GitHub) или MR (GitLab) из ветки прогона в ветку, от которой он стартовал. */
export async function openPullRequest(opts: { repo: string; branch: string; base: string; title: string; body: string; cfg: IntegrationsConfig }): Promise<{ url: string; kind: 'PR' | 'MR' }> {
  const o = await originOf(opts.repo);
  const host = o?.host ?? '';
  if (opts.cfg.github && (/github/i.test(host) || opts.cfg.github.repo)) {
    const c = opts.cfg.github;
    const api = (c.api ?? 'https://api.github.com').replace(/\/$/, '');
    const r = await call<{ html_url: string }>(
      `${api}/repos/${await githubRepo(c, opts.repo)}/pulls`,
      { method: 'POST', body: JSON.stringify({ title: opts.title, head: opts.branch, base: opts.base, body: opts.body }), headers: { authorization: `Bearer ${c.token}`, accept: 'application/vnd.github+json' } },
      'GitHub',
    );
    return { url: r.html_url, kind: 'PR' };
  }
  if (opts.cfg.gitlab) {
    const c = opts.cfg.gitlab;
    const base = (c.url ?? 'https://gitlab.com').replace(/\/$/, '');
    const r = await call<{ web_url: string }>(
      `${base}/api/v4/projects/${await gitlabProject(c, opts.repo)}/merge_requests`,
      { method: 'POST', body: JSON.stringify({ source_branch: opts.branch, target_branch: opts.base, title: opts.title, description: opts.body, remove_source_branch: true }), headers: { 'private-token': c.token } },
      'GitLab',
    );
    return { url: r.web_url, kind: 'MR' };
  }
  throw new Error('Чтобы открыть PR/MR, подключи GitHub или GitLab на вкладке «Задачи и git».');
}

/** Текст итога прогона для задачи и PR — пишет программа по фактам, не модель. */
export function runSummary(opts: {
  goal: string;
  done: string[];
  human: { id: string; why: string }[];
  files: { file: string; added: number; removed: number }[];
  goalCheck?: { achieved: boolean | null; missing?: string[] } | null;
  branch: string;
  pr?: string;
}): string {
  const lines = [
    'AgentYard: итог прогона',
    '',
    `Цель: ${opts.goal}`,
    `Сделано задач: ${opts.done.length}${opts.human.length ? `, ждут человека: ${opts.human.length}` : ''}.`,
  ];
  if (opts.goalCheck) lines.push(opts.goalCheck.achieved ? 'Приёмка: цель достигнута.' : `Приёмка: цель достигнута не полностью — ${(opts.goalCheck.missing ?? []).join('; ') || 'без пояснений'}.`);
  if (opts.files.length) lines.push('', 'Изменённые файлы:', ...opts.files.slice(0, 30).map((f) => `- ${f.file} (+${f.added} −${f.removed})`));
  if (opts.human.length) lines.push('', 'Осталось:', ...opts.human.map((h) => `- ${h.id}: ${h.why.slice(0, 200)}`));
  lines.push('', `Ветка: ${opts.branch}${opts.pr ? `\nPR: ${opts.pr}` : ''}`);
  return lines.join('\n');
}
