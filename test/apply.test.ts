// Доставка результата в проект: применить, отменить, не затереть свои правки пользователя.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createFeatureRepo, featureRuntime, FEATURE_GOAL } from '../src/demo.ts';
import { Pipeline } from '../src/pipeline.ts';
import { loadCatalog } from '../src/catalog.ts';
import { Stats } from '../src/stats.ts';
import { applyRun, unapplyRun, readMeta } from '../src/apply.ts';
import type { Hardware } from '../src/types.ts';

const HW: Hardware = { gpuName: 'test', vramTotalGb: 48, vramFreeGb: 48, ramTotalGb: 64, ramFreeGb: 32, cpuCores: 8, unifiedMemory: false, tier: 'T3' };
const shop = () => {
  const repo = path.join(mkdtempSync(path.join(tmpdir(), 'ay-apply-')), 'shop');
  createFeatureRepo(repo);
  return repo;
};
const run = (repo: string, autoApply: boolean) =>
  new Pipeline({ repo, goal: FEATURE_GOAL, runtime: featureRuntime(), catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, autoApply }).run();

test('автоприменение: результат сразу в ветке пользователя и в папке; отмена возвращает как было', async () => {
  const repo = shop();
  const res = await run(repo, true);
  assert.equal(res.applied?.ok, true, res.applied?.message ?? 'нет applied');
  assert.ok(existsSync(path.join(repo, 'src/promo.js')), 'файл должен появиться прямо в папке проекта');
  assert.deepEqual(res.changes.map((c) => c.file).sort(), ['src/promo.js', 'test/promo.test.js']);
  assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), 'master');
  const report = readFileSync(res.reportPath.replace(/html$/, 'md'), 'utf8');
  assert.match(report, /Результат уже применён/);
  assert.match(report, /## Что изменено в проекте/);
  // рабочие копии задач убраны
  assert.equal(execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').length, 1);

  const id = path.basename(res.runDir);
  const undo = await unapplyRun(repo, id);
  assert.equal(undo.ok, true, undo.message);
  assert.ok(!existsSync(path.join(repo, 'src/promo.js')));
  const again = await applyRun(repo, id);
  assert.equal(again.ok, true, again.message);
  assert.ok(existsSync(path.join(repo, 'src/promo.js')));
});

test('без автоприменения ветка пользователя не тронута; применение вручную; свои незакоммиченные правки не затираются', async () => {
  const repo = shop();
  const res = await run(repo, false);
  assert.equal(res.applied, undefined);
  assert.ok(!existsSync(path.join(repo, 'src/promo.js')));
  const id = path.basename(res.runDir);
  assert.equal(readMeta(repo, id)?.target, 'master');

  // пользователь сам начал писать тот же файл и не закоммитил
  writeFileSync(path.join(repo, 'src/promo.js'), '// мой черновик\n');
  const clash = await applyRun(repo, id);
  assert.equal(clash.ok, false);
  assert.match(clash.message, /src\/promo\.js/);
  assert.equal(readFileSync(path.join(repo, 'src/promo.js'), 'utf8'), '// мой черновик\n', 'черновик пользователя цел');

  // правки в другом файле — не мешают
  execFileSync('git', ['checkout', '--', '.'], { cwd: repo });
  execFileSync('git', ['clean', '-fdq', '--exclude=.agentyard'], { cwd: repo });
  writeFileSync(path.join(repo, 'README.md'), 'мои заметки\n');
  const ok = await applyRun(repo, id);
  assert.equal(ok.ok, true, ok.message);
  assert.equal(readFileSync(path.join(repo, 'README.md'), 'utf8'), 'мои заметки\n');
  assert.ok(existsSync(path.join(repo, 'src/promo.js')));
});

test('пользователь закоммитил своё после старта прогона — применяется слиянием', async () => {
  const repo = shop();
  const res = await run(repo, false);
  writeFileSync(path.join(repo, 'NOTES.md'), 'x\n');
  execFileSync('git', ['add', 'NOTES.md'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'мои заметки'], { cwd: repo });
  const r = await applyRun(repo, path.basename(res.runDir));
  assert.equal(r.ok, true, r.message);
  assert.equal(r.mode, 'merge');
  assert.ok(existsSync(path.join(repo, 'src/promo.js')) && existsSync(path.join(repo, 'NOTES.md')));
});
