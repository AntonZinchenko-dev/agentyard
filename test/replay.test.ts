// Повтор реального прогона «магазина» 19.10: планировщик сделал отдельную задачу-тест,
// а у правки поставил критерием `node -e "require(...)"`; кодер писал module.exports в проекте на import/export.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createFeatureRepo, FEATURE_GOAL, PROMO_CODE, PROMO_TEST } from '../src/demo.ts';
import { MockRuntime } from '../src/runtime/mock.ts';
import { Pipeline, firstLine } from '../src/pipeline.ts';
import { loadCatalog } from '../src/catalog.ts';
import { Stats } from '../src/stats.ts';
import { linkTestTasks } from '../src/plan.ts';
import { moduleHint, moduleStyleErrors } from '../src/checks.ts';
import { buildRepoMap, renderRepoMap, detectModuleSystem } from '../src/repomap.ts';
import { exampleSource } from '../src/agent.ts';
import type { ChatMessage, ChatRequest } from '../src/runtime/types.ts';
import type { Hardware, Plan } from '../src/types.ts';

const HW: Hardware = { gpuName: 'test', vramTotalGb: 48, vramFreeGb: 48, ramTotalGb: 64, ramFreeGb: 32, cpuCores: 8, unifiedMemory: false, tier: 'T3' };

const CJS_CODE = `function applyPromo(total, code) {
  if (code === 'SAVE10') return total * 0.9;
  if (code === 'FIX500') return Math.max(0, total - 500);
  throw new Error('Неизвестный промокод');
}

module.exports = { applyPromo };
`;

const BAD_PLAN = {
  tasks: [
    {
      id: 'T1',
      type: 'test',
      title: 'Создание тестов для promo',
      brief: 'Создать test/promo.test.js. Тесты должны использовать CommonJS require и Jest assertion methods.',
      dependsOn: [],
      files: ['test/promo.test.js'],
      newFiles: ['test/promo.test.js'],
      accept: { tests: ['test/promo.test.js'], commands: [] },
      size: 'S',
    },
    {
      id: 'T2',
      type: 'edit',
      title: 'Создание модуля promo',
      brief: 'Создать src/promo.js и экспортировать applyPromo.',
      dependsOn: ['T1'],
      files: ['src/promo.js'],
      newFiles: ['src/promo.js'],
      accept: { tests: [], commands: [`node -e "const {applyPromo} = require('./src/promo'); console.log(applyPromo(100, 'SAVE10'));"`] },
      size: 'M',
    },
  ],
};

/** stubborn=true — кодер упорно пишет CommonJS; иначе исправляется, увидев подсказку. */
function replayRuntime(stubborn: boolean): MockRuntime {
  const script = (req: ChatRequest): ChatMessage => {
    const system = req.messages[0]?.content ?? '';
    const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
    if (system.includes('планировщик')) return json(BAD_PLAN);
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('аналитик')) return json({ brief: 'Создай src/promo.js с applyPromo.', files: ['src/promo.js'] });
    if (system.includes('тестировщик')) return json({ patches: [{ file: 'test/promo.test.js', search: '', replace: PROMO_TEST }], note: 'тест' });
    if (system.includes('кодер')) {
      const fixed = !stubborn && /стиль модулей не совпадает/.test(user);
      return json({ patches: [{ file: 'src/promo.js', search: '', replace: fixed ? PROMO_CODE : CJS_CODE }], note: 'applyPromo' });
    }
    return json({});
  };
  return new MockRuntime(
    [
      { tag: 'qwen3.6:latest', sizeGb: 23 },
      { tag: 'gpt-oss:20b', sizeGb: 14 },
    ],
    script,
  );
}

test('план: правка после задачи-теста проверяется этим тестом, разовый node -e убирается', () => {
  const warnings: string[] = [];
  const plan = linkTestTasks({ goal: FEATURE_GOAL, ...structuredClone(BAD_PLAN) } as unknown as Plan, warnings);
  const t2 = plan.tasks[1]!;
  assert.deepEqual(t2.accept.tests, ['test/promo.test.js']);
  assert.deepEqual(t2.accept.commands, []);
  assert.deepEqual(t2.freeze, ['test/promo.test.js']);
  assert.equal(warnings.length, 2);
});

test('карта проекта говорит про ES-модули и node:test', () => {
  const repo = path.join(mkdtempSync(path.join(tmpdir(), 'ay-map-')), 'shop');
  createFeatureRepo(repo);
  const map = buildRepoMap(repo);
  assert.equal(map.moduleSystem, 'esm');
  const text = renderRepoMap(map);
  assert.match(text, /Модули: ES-модули/);
  assert.match(text, /Тест-раннер: node:test/);
  const ex = exampleSource(repo, 'src/promo.js');
  assert.ok(ex && ex.file.startsWith('src/') && /export /.test(ex.text));
});

test('стиль модулей: module.exports в ESM-проекте ловится сразу и с понятным объяснением', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ay-style-'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src/promo.js'), CJS_CODE);
  writeFileSync(path.join(dir, 'src/ok.js'), '// require(x) в комментарии не считается\nexport const a = 1;\n');
  assert.match(moduleStyleErrors(['src/promo.js'], dir, 'esm') ?? '', /export function/);
  assert.equal(moduleStyleErrors(['src/ok.js'], dir, 'esm'), null);
  assert.equal(moduleStyleErrors(['src/promo.js'], dir, null), null);
  assert.match(moduleHint('ReferenceError: module is not defined in ES module scope') ?? '', /ES-модулях/);
  assert.match(moduleHint("SyntaxError: The requested module '../src/promo.js' does not provide an export named 'applyPromo'") ?? '', /applyPromo/);
  assert.equal(detectModuleSystem(dir, ['src/ok.js']), 'esm');
});

test('первая строка ошибки — содержательная, а не заголовок ступени', () => {
  assert.equal(firstLine('Ступень 6 (команды):\n[eval]:1\n   ^\n\nTypeError: applyPromo is not a function\n    at [eval]:1:58'), 'TypeError: applyPromo is not a function');
});

test('повтор прогона 19.10: кодер исправляет стиль по подсказке — обе задачи готовы', async () => {
  const repo = path.join(mkdtempSync(path.join(tmpdir(), 'ay-replay-')), 'shop');
  createFeatureRepo(repo);
  const res = await new Pipeline({ repo, goal: FEATURE_GOAL, runtime: replayRuntime(false), catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true }).run();
  assert.deepEqual(res.done.sort(), ['T1', 'T2']);
  assert.deepEqual(res.human, []);
  const code = execFileSync('git', ['show', `${res.branch}:src/promo.js`], { cwd: repo, encoding: 'utf8' });
  assert.match(code, /export function applyPromo/);
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.match(journal, /стиль модулей|ступени 3/);
});

test('повтор прогона 19.10: код так и не получился — тест убран из ветки с честной причиной, ветка зелёная', async () => {
  const repo = path.join(mkdtempSync(path.join(tmpdir(), 'ay-replay2-')), 'shop');
  createFeatureRepo(repo);
  const res = await new Pipeline({ repo, goal: FEATURE_GOAL, runtime: replayRuntime(true), catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true }).run();
  assert.deepEqual(res.done, []);
  const t1 = res.human.find((h) => h.id === 'T1');
  assert.ok(t1, 'T1 должна быть у человека');
  // перед человеком программа просила другой подход: T2 могла смениться задачами T2.x — все они не получились
  assert.match(t1!.why, /код к нему \(T2[^)]*\) не получился/);
  assert.doesNotMatch(t1!.why, /сломала/);
  assert.ok(res.human.some((h) => /^T2/.test(h.id) && !/^не начата/.test(h.why)), JSON.stringify(res.human));
  assert.match(readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8'), /другой подход/);
  // ветка сборки проходит полный набор тестов
  const wt = mkdtempSync(path.join(tmpdir(), 'ay-wt-'));
  execFileSync('git', ['worktree', 'add', '-q', '--detach', wt, res.branch], { cwd: repo });
  const { NODE_TEST_CONTEXT: _x, ...env } = process.env;
  execFileSync('node', ['--test'], { cwd: wt, env, stdio: 'pipe' });
});

test('план: тест-файл в files правки с testFirst и забытый newFiles не роняют план', async () => {
  const { validatePlan } = await import('../src/plan.ts');
  const repo = path.join(mkdtempSync(path.join(tmpdir(), 'ay-plan-')), 'shop');
  createFeatureRepo(repo);
  const plan = {
    goal: FEATURE_GOAL,
    tasks: [
      { id: 'T1', type: 'edit', title: 'promo', brief: 'b', dependsOn: [], files: ['src/promo.js', 'test/promo.test.js'], accept: { tests: ['test/promo.test.js'], commands: [] }, size: 'S', testFirst: true },
    ],
  } as unknown as Plan;
  const r = validatePlan(plan, repo, 'T2');
  assert.equal(r.ok, true, r.errors.join('\n'));
  const test1 = r.plan.tasks.find((t) => t.id === 'T1-test')!;
  assert.deepEqual(test1.newFiles, ['test/promo.test.js']);
  const edit = r.plan.tasks.find((t) => t.id === 'T1')!;
  assert.ok(edit.newFiles?.includes('src/promo.js'));
});
