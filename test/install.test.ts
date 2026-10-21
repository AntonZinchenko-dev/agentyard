// Установка пакетов по плану: с разрешения, без порчи package.json пользователя до применения.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validSpec, pkgName } from '../src/install.ts';
import { createWebRepo } from '../src/demo.ts';
import { MockRuntime } from '../src/runtime/mock.ts';
import { Pipeline } from '../src/pipeline.ts';
import { loadCatalog } from '../src/catalog.ts';
import { Stats } from '../src/stats.ts';
import type { ChatMessage, ChatRequest } from '../src/runtime/types.ts';
import type { Hardware } from '../src/types.ts';

process.env.AGENTYARD_NPM = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-npm.mjs');
const HW: Hardware = { gpuName: 'test', vramTotalGb: 48, vramFreeGb: 48, ramTotalGb: 64, ramFreeGb: 32, cpuCores: 8, unifiedMemory: false, tier: 'T3' };

test('имена пакетов: обычные и scoped с версией — да; всё, что похоже на команду, — нет', () => {
  for (const s of ['react', '@mantine/core', '@mantine/core@7.17.0', 'zod@^3', 'lodash.debounce@~4.0.8']) assert.ok(validSpec(s), s);
  for (const s of ['evil; rm -rf /', 'a && b', '$(whoami)', '../x', 'a b', '@x', 'https://evil/x.tgz', 'git+ssh://x']) assert.ok(!validSpec(s), s);
  assert.equal(pkgName('@mantine/core@7.17.0'), '@mantine/core');
  assert.equal(pkgName('@mantine/core'), '@mantine/core');
});

function script(install: string[]) {
  return (req: ChatRequest): ChatMessage => {
    const system = req.messages[0]?.content ?? '';
    const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
    if (system.includes('планировщик')) {
      return json({
        understanding: 'Подключить Mantine и красить кнопки её цветом.',
        tasks: [{ id: 'T1', type: 'edit', title: 'Подключить Mantine', brief: 'Импорт стилей Mantine в общий CSS', dependsOn: [], files: ['src/shared/ui/generated.css'], install, accept: { tests: [], commands: [] }, size: 'S' }],
      });
    }
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('кодер')) return json({ patches: [{ file: 'src/shared/ui/generated.css', search: '.af-btn.primary { background: #2f6fdb; border-color: #2f6fdb; color: #fff; }', replace: '.af-btn.primary { background: var(--mantine-color-red-6); border-color: #2f6fdb; color: #fff; }' }], note: 'mantine' });
    return json({});
  };
}
const runtime = (install: string[]) => new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], script(install));

test('с разрешением: пакет поставлен, в ветке прогона — в package.json, после применения — у пользователя', async () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'ay-inst-')), 'web');
  createWebRepo(dir);
  const res = await new Pipeline({ repo: dir, goal: 'натяни мантину', runtime: runtime(['@mantine/core']), catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, autoApply: true, allowInstall: true }).run();
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(res.done, ['T1'], journal);
  assert.match(journal, /поставлены пакеты @mantine\/core@7\.17\.0/);
  assert.ok(existsSync(path.join(dir, 'node_modules/@mantine/core/package.json')));
  assert.ok(res.changes.some((c) => c.file === 'package.json'));
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['@mantine/core'], '^7.17.0');
  assert.match(journal, /После применения выполнен npm install/);
});

test('без разрешения — задача к человеку с готовой командой; при ошибке npm — тоже, с причиной', async () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'ay-inst2-')), 'web');
  createWebRepo(dir);
  const res = await new Pipeline({ repo: dir, goal: 'натяни мантину', runtime: runtime(['@mantine/core']), catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, autoApply: true }).run();
  assert.equal(res.human[0]?.id, 'T1');
  assert.match(res.human[0]!.why, /npm install @mantine\/core/);
  assert.ok(!existsSync(path.join(dir, 'node_modules')));

  const dir2 = path.join(mkdtempSync(path.join(tmpdir(), 'ay-inst3-')), 'web');
  createWebRepo(dir2);
  const res2 = await new Pipeline({ repo: dir2, goal: 'натяни', runtime: runtime(['does-not-exist-pkg']), catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, allowInstall: true }).run();
  assert.match(res2.human[0]!.why, /404/);
});

test('npm не ставит старую версию из памяти модели (ERESOLVE) — свежая версия; конфликт peer — --legacy-peer-deps', async () => {
  const { installPackages, dedupeSpecs } = await import('../src/install.ts');
  assert.deepEqual(dedupeSpecs(['@mantine/core', '@mantine/hooks', '@mantine/hooks@7.0.0', '@mantine/core@7.0.0']), ['@mantine/core', '@mantine/hooks']);
  const dir = mkdtempSync(path.join(tmpdir(), 'ay-npm-'));
  const r1 = await installPackages(dir, ['@mantine/hooks@7.0.0']);
  assert.ok(r1.ok, r1.output);
  assert.match(r1.note!, /свежие/);
  assert.equal(r1.versions['@mantine/hooks'], '7.17.0');
  const r2 = await installPackages(dir, ['ui-needs-legacy']);
  assert.ok(r2.ok, r2.output);
  assert.match(r2.note!, /legacy-peer-deps/);
  const r3 = await installPackages(dir, ['does-not-exist-pkg']);
  assert.equal(r3.ok, false, '404 не лечится повторами');
});

test('пакет встал только с --legacy-peer-deps — в проект пишется .npmrc, чтобы npm install в Docker тоже прошёл', async () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'ay-inst4-')), 'web');
  createWebRepo(dir);
  const res = await new Pipeline({ repo: dir, goal: 'натяни мантину', runtime: runtime(['ui-needs-legacy']), catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, autoApply: true, allowInstall: true }).run();
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(res.done, ['T1'], journal);
  assert.match(journal, /legacy-peer-deps/);
  assert.match(readFileSync(path.join(dir, '.npmrc'), 'utf8'), /legacy-peer-deps=true/);
});
