// Сквозной прогон на учебном репозитории с учебной моделью (без Ollama).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDemoRepo, demoRuntime } from '../src/demo.ts';
import { Pipeline } from '../src/pipeline.ts';
import { loadCatalog } from '../src/catalog.ts';
import { Stats } from '../src/stats.ts';
import type { Hardware } from '../src/types.ts';

const HW: Hardware = { gpuName: 'test', vramTotalGb: 48, vramFreeGb: 48, ramTotalGb: 64, ramFreeGb: 32, cpuCores: 8, unifiedMemory: false, tier: 'T3' };

test('конвейер чинит оба теста, не трогая основную ветку', async () => {
  const repo = path.join(mkdtempSync(path.join(tmpdir(), 'ay-e2e-')), 'demo');
  createDemoRepo(repo);
  const mainBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();

  const runtime = demoRuntime();
  const res = await new Pipeline({
    repo,
    goal: 'fix-tests',
    runtime,
    catalog: loadCatalog(),
    hardware: HW,
    stats: new Stats(null),
    quiet: true,
  }).run();

  assert.deepEqual(res.done.sort(), ['T1', 'T2']);
  assert.equal(res.human.length, 0);

  // основная ветка не тронута
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim(), mainBefore);

  // на ветке сборки все тесты зелёные, тесты не менялись
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo }).toString();
  const changed = git('diff', '--name-only', `${mainBefore}..${res.branch}`).trim().split('\n').sort();
  assert.deepEqual(changed, ['src/price.js', 'src/text.js']);
  git('checkout', '-q', res.branch);
  execFileSync('node', ['--test'], { cwd: repo, stdio: 'ignore' }); // бросит, если тесты красные
  git('checkout', '-q', '-');

  // журнал: была переделка T2 с первой попытки, ревью и отчёт
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.match(journal, /T2: попытка 1, ступень 2/);
  assert.match(journal, /Ревьюер .* принял T1/);
  assert.match(journal, /Полный набор тестов на ветке сборки — зелёный/);
  assert.ok(existsSync(res.reportPath));
  assert.match(readFileSync(res.reportPath, 'utf8'), /Почему этому можно доверять/);

  // рабочие копии задач убраны
  const worktrees = git('worktree', 'list').trim().split('\n');
  assert.equal(worktrees.length, 1);
});

test('на двух задачах «первая деталь партии» не добавляет лишних смен модели', async () => {
  const repo = path.join(mkdtempSync(path.join(tmpdir(), 'ay-e2e-')), 'demo');
  createDemoRepo(repo);
  const runtime = demoRuntime();
  const res = await new Pipeline({ repo, goal: 'fix-tests', runtime, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true }).run();
  assert.deepEqual(res.done.sort(), ['T1', 'T2']);
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.doesNotMatch(journal, /первая деталь партии/);
  assert.match(readFileSync(res.reportPath, 'utf8'), /Куда ушло время/);
});

import { createFeatureRepo, featureRuntime, FEATURE_GOAL } from '../src/demo.ts';

test('цель обычными словами: план от модели → сначала тест (красный) → код → ревью', async () => {
  const repo = path.join(mkdtempSync(path.join(tmpdir(), 'ay-feat-')), 'shop');
  createFeatureRepo(repo);
  const res = await new Pipeline({ repo, goal: FEATURE_GOAL, runtime: featureRuntime(), catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true }).run();
  assert.deepEqual(res.done.sort(), ['T1', 'T1-test']);
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.match(journal, /Тестировщик .* сдал T1-test/);
  assert.match(journal, /Проверки T1-test: все ступени пройдены/);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo }).toString();
  const files = git('diff', '--name-only', `HEAD..${res.branch}`).trim().split('\n').sort();
  assert.deepEqual(files, ['src/promo.js', 'test/promo.test.js']);
});
