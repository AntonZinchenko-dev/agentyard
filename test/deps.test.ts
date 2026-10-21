// Зависимости, которые использует код прогона, должны быть в package.json (с обязательными peer): иначе в Docker
// (`npm install --legacy-peer-deps` по package.json) — «Module not found: Can't resolve '@mantine/hooks'».
// И подпапка репозитория (web/ внутри проекта): правки ложатся в web/, а не в корень репозитория.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWebRepo } from '../src/demo.ts';
import { MockRuntime } from '../src/runtime/mock.ts';
import { Pipeline } from '../src/pipeline.ts';
import { loadCatalog } from '../src/catalog.ts';
import { Stats } from '../src/stats.ts';
import { addDependencies, missingPeers } from '../src/install.ts';
import { gitScope } from '../src/git.ts';
import type { ChatMessage, ChatRequest } from '../src/runtime/types.ts';
import type { Hardware } from '../src/types.ts';

const HW: Hardware = { gpuName: 'test', vramTotalGb: 16, vramFreeGb: 16, ramTotalGb: 32, ramFreeGb: 24, cpuCores: 8, unifiedMemory: false, tier: 'T2' };
const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
const PAGE = 'src/pages/address-list/ui/AddressListPage.tsx';
const INSTALLED = [{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }];
const gitShow = (repo: string, ref: string) => execFileSync('git', ['show', ref], { cwd: repo, encoding: 'utf8' });

/** Пакет в node_modules, как его оставляет npm. */
function fakePkg(dir: string, name: string, version: string, extra: Record<string, unknown> = {}): void {
  const d = path.join(dir, 'node_modules', ...name.split('/'));
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name, version, ...extra }));
}

function mantine(dir: string): void {
  fakePkg(dir, '@mantine/core', '9.7.3', {
    peerDependencies: { '@mantine/hooks': '9.7.3', react: '^19.2.0', 'react-dom': '^19.2.0', '@types/react': '*' },
    peerDependenciesMeta: { '@types/react': { optional: true } },
  });
  fakePkg(dir, '@mantine/hooks', '9.7.3', { peerDependencies: { react: '^19.2.0' } });
}

test('missingPeers: обязательные peer пакета, без необязательных и уже записанных', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ay-peers-'));
  mantine(dir);
  assert.deepEqual(missingPeers(dir, ['@mantine/core'], new Set(['react', 'react-dom'])), { '@mantine/hooks': '9.7.3' });
  // peer не установлен — берём диапазон из peerDependencies, в package.json он пишется как есть
  const all = missingPeers(dir, ['@mantine/core']);
  assert.equal(all.react, '^19.2.0');
  assert.ok(!('@types/react' in all), 'необязательный peer пропущен');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { next: '^15' } }, null, 2));
  addDependencies(dir, { '@mantine/core': '9.7.3', react: '^19.2.0' });
  const pkg = JSON.parse(execFileSync('node', ['-e', 'process.stdout.write(require("fs").readFileSync("package.json","utf8"))'], { cwd: dir, encoding: 'utf8' }));
  assert.deepEqual(pkg.dependencies, { '@mantine/core': '^9.7.3', next: '^15', react: '^19.2.0' });
});

test('код ветки импортирует пакет из node_modules, которого нет в package.json, — программа дописывает его и обязательный peer', async () => {
  const repo = path.join(mkdtempSync(path.join(tmpdir(), 'ay-deps-')), 'web');
  createWebRepo(repo);
  // пакет поставлен раньше (--no-save по задаче, которая ушла человеку) — в node_modules есть, в package.json нет
  mantine(repo);
  const plan = [{ id: 'T1', type: 'edit', title: 'Таблица из Mantine', brief: 'Таблица', dependsOn: [], files: [PAGE], accept: { tests: [], commands: [] }, size: 'S' }];
  const rt = new MockRuntime(INSTALLED, (req: ChatRequest) => {
    const system = req.messages[0]?.content ?? '';
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('планировщик')) return json({ understanding: 'x', tasks: plan });
    return json({ patches: [{ file: PAGE, search: '<h1>', replace: '<h1 data-kit="mantine">' }, { file: PAGE, search: "import Link from 'next/link'", replace: "import Link from 'next/link'\nimport { Table } from '@mantine/core'" }], note: 'Mantine' });
  });
  const r = await new Pipeline({ repo, goal: 'таблицы из mantine', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, sampling: 1, allowInstall: false }).run();
  assert.ok(r.done.includes('T1'), JSON.stringify(r.human));
  const code = gitShow(repo, `${r.branch}:${PAGE}`);
  assert.match(code, /@mantine\/core/, 'правка с импортом влита');
  const pkg = JSON.parse(gitShow(repo, `${r.branch}:package.json`));
  assert.equal(pkg.dependencies['@mantine/core'], '^9.7.3');
  assert.equal(pkg.dependencies['@mantine/hooks'], '^9.7.3', 'обязательный peer записан явно — Docker с --legacy-peer-deps его иначе не поставит');
  assert.ok(r.changes.some((c) => c.file === 'package.json'), 'package.json в списке изменений');
});

test('подпапка репозитория: gitScope видит корень и папку, планировщику сказано работать в ней', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ay-scope-'));
  const web = path.join(root, 'web');
  createWebRepo(web);
  // createWebRepo делает свой репозиторий — убираем его: репозиторий один, на весь проект
  execFileSync(process.platform === 'win32' ? 'cmd' : 'rm', process.platform === 'win32' ? ['/c', 'rmdir', '/s', '/q', path.join(web, '.git')] : ['-rf', path.join(web, '.git')]);
  mkdirSync(path.join(root, 'backend'));
  writeFileSync(path.join(root, 'backend', 'README.md'), 'backend\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: root });

  const scope = await gitScope(web);
  assert.ok(scope);
  assert.equal(path.resolve(scope.root), path.resolve(root));
  assert.equal(scope.focus, 'web');
  assert.equal(await gitScope(root), null, 'корень — не подпапка');

  const plan = [{ id: 'T1', type: 'edit', title: 'Заголовок', brief: 'Заголовок', dependsOn: [], files: [`web/${PAGE}`], accept: { tests: [], commands: [] }, size: 'S' }];
  let plannerSaw = '';
  const rt = new MockRuntime(INSTALLED, (req: ChatRequest) => {
    const system = req.messages[0]?.content ?? '';
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('планировщик')) {
      plannerSaw = req.messages.map((m) => m.content).join('\n');
      return json({ understanding: 'x', tasks: plan });
    }
    return json({ patches: [{ file: `web/${PAGE}`, search: '<h1>', replace: '<h1 title="Адреса">' }], note: 'заголовок' });
  });
  const r = await new Pipeline({ repo: scope.root, focus: scope.focus, goal: 'заголовок на странице адресов', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, sampling: 1 }).run();
  assert.match(plannerSaw, /Человек выбрал папку web\/ .*пути файлов задач начинаются с «web\/»/s);
  assert.ok(r.done.includes('T1'), JSON.stringify(r.human));
  assert.ok(r.changes.every((c) => c.file.startsWith('web/')), `правки только в web/: ${r.changes.map((c) => c.file).join(', ')}`);
});
