// Доски и git против поддельных серверов: задачи как цели, итог в задачу, push и PR/MR.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { adfText, allIssues, commentIssue, loadConfig, openPullRequest, parseRemote, publicConfig, pushBranch, runSummary, saveProvider } from '../src/integrations.ts';

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: any };

async function fake(handler: (s: Seen) => unknown): Promise<{ base: string; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const s = { method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      seen.push(s);
      const out = handler(s);
      if (out === 404) {
        res.statusCode = 404;
        return res.end('{"message":"Not Found"}');
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => server.close() };
}

test('адрес origin: github по ssh и https, gitlab с подгруппой', () => {
  assert.deepEqual(parseRemote('git@github.com:anton/web.git'), { host: 'github.com', path: 'anton/web' });
  assert.deepEqual(parseRemote('https://github.com/anton/web'), { host: 'github.com', path: 'anton/web' });
  assert.deepEqual(parseRemote('https://user@gitlab.company.ru/team/sub/api.git'), { host: 'gitlab.company.ru', path: 'team/sub/api' });
  assert.deepEqual(parseRemote('ssh://git@gitlab.company.ru:2222/team/api.git'), { host: 'gitlab.company.ru', path: 'team/api' });
});

test('настройки: токены хранятся у пользователя, окну не показываются; пустое поле токена не стирает сохранённый', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'ay-int-')), 'integrations.json');
  saveProvider('github', { token: 'ghp_secret', repo: 'a/b' }, file);
  saveProvider('github', { token: '', repo: 'a/c' }, file);
  const cfg = loadConfig(file);
  assert.equal(cfg.github?.token, 'ghp_secret');
  assert.equal(cfg.github?.repo, 'a/c');
  assert.deepEqual(publicConfig(cfg), { github: { token: '••• задан', repo: 'a/c' } });
  saveProvider('github', null, file);
  assert.deepEqual(loadConfig(file), {});
});

test('задачи со всех досок: GitHub (без PR), GitLab, Jira (Cloud и Server), YouTrack, Trello; ошибка одной не мешает другим', async () => {
  const srv = await fake((s) => {
    if (s.url.startsWith('/repos/a/b/issues')) return [{ number: 7, title: 'Красные кнопки', body: 'Сделай', html_url: 'https://gh/7' }, { number: 8, title: 'PR', body: '', html_url: 'x', pull_request: {} }];
    if (s.url.startsWith('/api/v4/projects/team%2Fapi/issues')) return [{ iid: 3, title: 'Эндпоинт заказов', description: null, web_url: 'https://gl/3' }];
    if (s.url.startsWith('/rest/api/3/search/jql')) return 404;
    if (s.url.startsWith('/rest/api/2/search')) return { issues: [{ key: 'WEB-12', fields: { summary: 'Тёмная тема', description: 'Для всех страниц' } }] };
    if (s.url.startsWith('/api/issues')) return [{ idReadable: 'YT-1', summary: 'Порт 8080', description: '' }];
    if (s.url.startsWith('/1/boards/B1/cards')) return [{ id: 'c1', name: 'Липкая шапка', desc: 'таблицы', shortUrl: 'https://trello/c1', idList: 'L1' }];
    return 404;
  });
  process.env.AGENTYARD_TRELLO_API = srv.base;
  try {
    const cfg = {
      github: { token: 't', repo: 'a/b', api: srv.base },
      gitlab: { token: 't', url: srv.base, project: 'team/api' },
      jira: { url: srv.base, token: 'pat' },
      youtrack: { url: srv.base, token: 'perm' },
      trello: { key: 'k', token: 't', boardId: 'B1' },
    };
    const { issues, errors } = await allIssues(cfg);
    assert.deepEqual(errors, []);
    assert.deepEqual(issues.map((i) => `${i.provider}:${i.key}:${i.title}`).sort(), ['github:#7:Красные кнопки', 'gitlab:#3:Эндпоинт заказов', 'jira:WEB-12:Тёмная тема', 'trello:карточка:Липкая шапка', 'youtrack:YT-1:Порт 8080']);
    assert.equal(srv.seen.find((s) => s.url.startsWith('/rest/api/2'))!.headers.authorization, 'Bearer pat');
    assert.equal(srv.seen.find((s) => s.url.startsWith('/api/v4'))!.headers['private-token'], 't');
    const broken = await allIssues({ ...cfg, github: { token: 't', repo: 'нет/такого', api: srv.base } });
    assert.equal(broken.errors[0]?.provider, 'github');
    assert.match(broken.errors[0]!.error, /404 — проверь адрес/);
    assert.equal(broken.issues.length, 4);
  } finally {
    delete process.env.AGENTYARD_TRELLO_API;
    srv.close();
  }
});

test('итог в задачу и PR: правильные адреса и тела; описание Jira v3 (ADF) — в текст', async () => {
  const srv = await fake((s) => (s.url.endsWith('/pulls') ? { html_url: 'https://gh/pull/9' } : s.url.endsWith('/merge_requests') ? { web_url: 'https://gl/mr/4' } : {}));
  try {
    const gh = { github: { token: 't', repo: 'a/b', api: srv.base } };
    await commentIssue({ provider: 'github', id: '7' }, 'итог', gh);
    assert.equal(srv.seen.at(-1)!.url, '/repos/a/b/issues/7/comments');
    assert.equal(srv.seen.at(-1)!.body.body, 'итог');
    await commentIssue({ provider: 'jira', id: 'WEB-12' }, 'итог', { jira: { url: srv.base, token: 'tok', email: 'a@b.c' } });
    assert.equal(srv.seen.at(-1)!.url, '/rest/api/2/issue/WEB-12/comment');
    assert.match(String(srv.seen.at(-1)!.headers.authorization), /^Basic /);
    const repo = mkdtempSync(path.join(tmpdir(), 'ay-pr-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:a/b.git'], { cwd: repo });
    const pr = await openPullRequest({ repo, branch: 'agentyard/run-1', base: 'main', title: 'T', body: 'B', cfg: gh });
    assert.deepEqual(pr, { url: 'https://gh/pull/9', kind: 'PR' });
    assert.deepEqual(srv.seen.at(-1)!.body, { title: 'T', head: 'agentyard/run-1', base: 'main', body: 'B' });
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://gitlab.company.ru/team/api.git'], { cwd: repo });
    const mr = await openPullRequest({ repo, branch: 'agentyard/run-1', base: 'main', title: 'T', body: 'B', cfg: { gitlab: { token: 't', url: srv.base } } });
    assert.equal(mr.kind, 'MR');
    assert.equal(srv.seen.at(-1)!.url, '/api/v4/projects/team%2Fapi/merge_requests');
  } finally {
    srv.close();
  }
  assert.equal(adfText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Привет' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'мир' }] }] }).trim(), 'Привет\n\nмир');
  const sum = runSummary({ goal: 'g', done: ['T1'], human: [], files: [{ file: 'a.css', added: 1, removed: 1 }], goalCheck: { achieved: true }, branch: 'agentyard/run-1', pr: 'https://gh/pull/9' });
  assert.match(sum, /Приёмка: цель достигнута/);
  assert.match(sum, /a\.css \(\+1 −1\)/);
});

test('push ветки прогона в origin (локальный «сервер» — голый репозиторий)', async () => {
  const remote = mkdtempSync(path.join(tmpdir(), 'ay-remote-'));
  execFileSync('git', ['init', '-q', '--bare'], { cwd: remote });
  const repo = mkdtempSync(path.join(tmpdir(), 'ay-push-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  g('branch', 'agentyard/run-1');
  await assert.rejects(pushBranch(repo, 'agentyard/run-1'), /нет remote origin/);
  g('remote', 'add', 'origin', remote);
  await pushBranch(repo, 'agentyard/run-1');
  assert.match(execFileSync('git', ['branch', '--list'], { cwd: remote, encoding: 'utf8' }), /agentyard\/run-1/);
  assert.ok(existsSync(remote));
  assert.ok(readFileSync(path.join(remote, 'HEAD'), 'utf8'));
});

test('сервер: прогон из задачи доски → итог записан комментарием в задачу, отметка в run.json', async () => {
  const { startServer } = await import('../src/server.ts');
  const { createWebRepo } = await import('../src/demo.ts');
  const { MockRuntime } = await import('../src/runtime/mock.ts');
  const { readMeta } = await import('../src/apply.ts');
  const gh = await fake((s) => (s.url.endsWith('/comments') ? { id: 1 } : 404));
  process.env.AGENTYARD_INTEGRATIONS = path.join(mkdtempSync(path.join(tmpdir(), 'ay-intsrv-')), 'integrations.json');
  saveProvider('github', { token: 't', repo: 'a/b', api: gh.base });
  const repo = path.join(mkdtempSync(path.join(tmpdir(), 'ay-intrun-')), 'web');
  createWebRepo(repo);
  const PAGE = 'src/pages/address-list/ui/AddressListPage.tsx';
  const rt = () => new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], (req) => {
    const system = req.messages[0]?.content ?? '';
    const json = (o: unknown) => ({ role: 'assistant' as const, content: JSON.stringify(o) });
    if (system.includes('планировщик')) return json({ understanding: 'x', tasks: [{ id: 'T1', type: 'edit', title: 'Заголовок', brief: 'b', dependsOn: [], files: [PAGE], accept: { tests: [], commands: [] }, size: 'S' }] });
    if (system.includes('кодер')) return json({ patches: [{ file: PAGE, search: '<h1>Адреса</h1>', replace: '<h1>Адреса доставки</h1>' }], note: 'ok' });
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    return json({ verdict: 'approve', reasons: [] });
  });
  const srv = await startServer({ hardware: async () => ({ gpuName: 't', vramTotalGb: 48, vramFreeGb: 48, ramTotalGb: 64, ramFreeGb: 32, cpuCores: 8, unifiedMemory: false, tier: 'T3' }), statsPath: null, runtimeFactory: () => rt() });
  try {
    const post = async (p: string, body: unknown) => (await fetch(`http://127.0.0.1:${srv.port}${p}`, { method: 'POST', headers: { 'x-ay-token': srv.token, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>;
    const { runId } = await post('/api/run', { repo, goal: 'Заголовок адресов', approve: 'never', issue: { provider: 'github', id: '7', key: '#7', url: 'https://gh/7', title: 'Заголовок' } });
    for (let i = 0; i < 100 && !readMeta(repo, runId); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(readMeta(repo, runId)?.issue?.key, '#7');
    const r = await post('/api/publish', { repo, id: runId, comment: true });
    assert.deepEqual(r.steps.map((s: any) => s.ok), [true], JSON.stringify(r));
    const sent = gh.seen.find((s) => s.url === '/repos/a/b/issues/7/comments')!;
    assert.match(sent.body.body, /AgentYard: итог прогона[\s\S]*AddressListPage\.tsx/);
    assert.equal(readMeta(repo, runId)?.published?.commented, 'https://gh/7');
  } finally {
    await srv.close();
    gh.close();
    delete process.env.AGENTYARD_INTEGRATIONS;
  }
});
