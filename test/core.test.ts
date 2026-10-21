// Юнит-тесты ядра: граф, диспетчер, план, заплатки, статистика, бригада, bisect.
// Запуск: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskGraph } from '../src/graph.ts';
import { validatePlan } from '../src/plan.ts';
import { applyPatches } from '../src/tools/patch.ts';
import { safePath } from '../src/tools/fs.ts';
import { Stats } from '../src/stats.ts';
import { selectTeam, subsets } from '../src/team.ts';
import { chooseNext, type WorkItem } from '../src/dispatcher.ts';
import { bisectFirstBad } from '../src/git.ts';
import { tierFor } from '../src/hardware.ts';
import { loadCatalog } from '../src/catalog.ts';
import type { CatalogModel, Hardware, PlannedTask } from '../src/types.ts';

const task = (id: string, dependsOn: string[] = [], files: string[] = ['a.js']): PlannedTask => ({
  id,
  type: 'edit',
  title: id,
  brief: id,
  dependsOn,
  files,
  accept: { tests: ['a.test.js'], commands: [] },
  size: 'S',
});

const tmp = () => mkdtempSync(path.join(tmpdir(), 'ay-'));

test('граф: вес = 1 + число потомков, готовность по зависимостям', () => {
  const g = new TaskGraph([task('A'), task('B', ['A']), task('C', ['B']), task('D')]);
  assert.equal(g.get('A').weight, 3);
  assert.equal(g.get('B').weight, 2);
  assert.equal(g.get('D').weight, 1);
  assert.deepEqual(g.byStatus('ready').map((t) => t.id).sort(), ['A', 'D']);
  g.setStatus('A', 'done');
  assert.equal(g.get('B').status, 'ready');
});

test('граф: матрёшка — задача становится составной, части встают на её место, B ждёт сборки A', () => {
  const g = new TaskGraph([task('A'), task('B', ['A'])]);
  g.split('A', [task('A.1'), task('A.2', ['A.1'])]);
  assert.deepEqual(g.get('B').dependsOn, ['A'], 'B ждёт сборки A, а не отдельных частей');
  assert.deepEqual(g.get('A').children, ['A.1', 'A.2']);
  assert.equal(g.get('A').status, 'waiting');
  assert.equal(g.get('A.1').parent, 'A');
  assert.equal(TaskGraph.splitDepth('A.2'), 1);
  assert.equal(g.depth('A.2'), 1);
  assert.equal(g.get('A.1').status, 'ready');
  assert.equal(g.get('A.2').status, 'waiting');
  // очередь: части — на месте родителя, раньше B
  assert.ok(g.get('A.1').seq! < g.get('A.2').seq! && g.get('A.2').seq! < g.get('B').seq!);
  // вес: от частей ждёт родитель и всё, что ждёт его
  assert.equal(g.get('A.1').weight, 4);
  g.setStatus('A.1', 'done');
  g.setStatus('A.2', 'done');
  assert.deepEqual(g.assemblable().map((t) => t.id), ['A'], 'все части сделаны — пора собрать');
  assert.equal(g.get('B').status, 'waiting', 'B не стартует, пока A не собрана');
  g.setStatus('A', 'done');
  assert.equal(g.get('B').status, 'ready');
});

test('план: цикл и отсутствие критерия ловятся кодом', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'a.js'), '');
  const bad = validatePlan(
    { goal: 'x', tasks: [task('A', ['B']), task('B', ['A']), { ...task('C'), accept: { tests: [], commands: [] } }] },
    dir,
    'T3',
  );
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('цикл')));
  assert.ok(bad.errors.some((e) => e.includes('C: нет критерия')));
});

test('план: файловый замок ставит зависимость между задачами с общим файлом', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'a.js'), '');
  const res = validatePlan({ goal: 'x', tasks: [task('A'), task('B')] }, dir, 'T3');
  assert.equal(res.ok, true);
  assert.deepEqual(res.plan.tasks[1]!.dependsOn, ['A']);
  assert.equal(res.warnings.length, 1);
});

test('план: «сначала тест» добавляет задачу тестировщика и замораживает тест', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'a.js'), '');
  const res = validatePlan(
    { goal: 'x', tasks: [{ ...task('A'), testFirst: true, accept: { tests: ['new.test.js'], commands: [] } }] },
    dir,
    'T3',
  );
  assert.equal(res.ok, true, res.errors.join('\n'));
  assert.deepEqual(res.plan.tasks.map((t) => t.id), ['A-test', 'A']);
  const g = new TaskGraph(res.plan.tasks);
  assert.deepEqual(g.get('A').frozenFiles, ['new.test.js']);
  assert.deepEqual(g.get('A-test').frozenFiles, []);
});

test('заплатки: фрагмент должен встречаться ровно один раз, изменения атомарны', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'a.js'), 'x = 1;\ny = 1;\nx = 1;\n');
  writeFileSync(path.join(dir, 'b.js'), 'b = 1;\n');
  const twice = applyPatches(dir, [
    { file: 'b.js', search: 'b = 1;', replace: 'b = 2;' },
    { file: 'a.js', search: 'x = 1;', replace: 'x = 2;' },
  ]);
  assert.equal(twice.ok, false);
  assert.match(twice.errors[0]!, /2 раз/);
  assert.equal(readFileSync(path.join(dir, 'b.js'), 'utf8'), 'b = 1;\n', 'при ошибке ничего не меняется');

  const ok = applyPatches(dir, [{ file: 'a.js', search: 'y = 1;', replace: 'y = 2;' }]);
  assert.equal(ok.ok, true);
  assert.equal(readFileSync(path.join(dir, 'a.js'), 'utf8'), 'x = 1;\ny = 2;\nx = 1;\n');

  const frozen = applyPatches(dir, [{ file: 'a.js', search: 'y = 2;', replace: '' }], ['a.js']);
  assert.equal(frozen.ok, false);
  assert.match(frozen.errors[0]!, /заморожен/);
});

test('заплатки: создание файла и защита от выхода за папку проекта', () => {
  const dir = tmp();
  mkdirSync(path.join(dir, 'src'));
  assert.equal(applyPatches(dir, [{ file: 'src/new.js', search: '', replace: 'ok' }]).ok, true);
  assert.throws(() => safePath(dir, '../etc/passwd'));
  assert.throws(() => safePath(dir, '/etc/passwd'));
  assert.equal(applyPatches(dir, [{ file: '../x.js', search: '', replace: 'x' }]).ok, false);
});

test('статистика: пример из документа — каталог 0,7, успехов 4 из 10 → 0,45', () => {
  const s = new Stats(null);
  const m = { id: 'm', roles: { coder: 0.7 } } as CatalogModel;
  for (let i = 0; i < 10; i++) s.recordOutcome('m', 'coder', 'M', i < 4);
  assert.equal(Math.round(s.successRate(m, 'coder', 'M') * 100) / 100, 0.45);
});

const hw = (vram: number, tier: Hardware['tier'] = 'T3'): Hardware => ({
  gpuName: 'test',
  vramTotalGb: vram,
  vramFreeGb: vram,
  ramTotalGb: 32,
  ramFreeGb: 16,
  cpuCores: 8,
  unifiedMemory: false,
  tier,
});

test('бригада: на 24 ГБ — основная модель плюс отдельный ревьюер', () => {
  const cat = loadCatalog();
  const pick = (ids: string[]) => cat.filter((m) => ids.includes(m.id));
  const team = selectTeam(pick(['qwen3.6-35b-a3b', 'gpt-oss-20b', 'gemma4-12b']), hw(48), new Stats(null));
  assert.equal(team.byRole.coder.id, 'qwen3.6-35b-a3b');
  assert.notEqual(team.byRole.reviewer.id, team.byRole.coder.id);
  assert.equal(team.models.length, 2);
});

test('бригада: на слабом железе — одна модель, крупные не влезают', () => {
  const cat = loadCatalog();
  const team = selectTeam(cat, hw(8, 'T1'), new Stats(null));
  assert.equal(team.models.length, 1);
  const m = team.models[0]!;
  // либо плотная модель целиком в видеопамяти, либо MoE с частью в оперативке
  assert.ok(m.memoryGbQ4 <= 6.1 || isMoE(m), m.id);
  assert.ok(m.memoryGbQ4 < 23, 'крупные модели всё равно не влезают');
});

test('бригада: перебор подмножеств', () => {
  assert.equal([...subsets([1, 2, 3, 4], 2)].length, 4 + 6);
});

test('диспетчер: гистерезис держит загруженную модель при близких оценках', () => {
  const cat = loadCatalog();
  const a = cat.find((m) => m.id === 'qwen3.6-35b-a3b')!;
  const b = cat.find((m) => m.id === 'devstral-small-2')!;
  const stats = new Stats(null);
  const g = new TaskGraph([task('A'), task('B', [], ['b.js'])]);
  const items: WorkItem[] = g.byStatus('ready').map((t) => ({ task: t, role: 'coder', kind: 'work' }));
  const team = { models: [a, b], byRole: {} as never, score: 0 };
  const now = Date.now();
  const onB = chooseNext(items, { team, stats, loadedModelId: b.id, now, fits: () => true })!;
  assert.equal(onB.model.id, b.id, 'чуть более слабая, но загруженная модель остаётся у плиты');
  const cold = chooseNext(items, { team, stats, loadedModelId: null, now, fits: () => true })!;
  assert.equal(cold.model.id, a.id, 'без загруженной модели берём сильнейшую');
});

test('диспетчер: старение поднимает давно ждущую задачу', () => {
  const cat = loadCatalog();
  const m = cat[0]!;
  const stats = new Stats(null);
  const now = Date.now();
  const g = new TaskGraph([task('A', [], ['a.js']), task('B', [], ['b.js'])], now);
  g.get('B').readySince = now - 20 * 60_000;
  const items: WorkItem[] = g.byStatus('ready').map((t) => ({ task: t, role: 'coder', kind: 'work' }));
  const pick = chooseNext(items, { team: { models: [m], byRole: {} as never, score: 0 }, stats, loadedModelId: m.id, now, fits: () => true })!;
  assert.equal(pick.item.task.id, 'B');
});

test('bisect: находит первый плохой коммит за log2(n) проверок', async () => {
  const commits = Array.from({ length: 16 }, (_, i) => `c${i}`);
  let checks = 0;
  const bad = await bisectFirstBad(commits, async (sha) => {
    checks += 1;
    return Number(sha.slice(1)) < 11;
  });
  assert.equal(bad, 'c11');
  assert.ok(checks <= 5);
});

test('тиры по видеопамяти', () => {
  assert.equal(tierFor(0, 16, false), 'T0');
  assert.equal(tierFor(8, 16, false), 'T1');
  assert.equal(tierFor(16, 32, false), 'T2');
  assert.equal(tierFor(24, 64, false), 'T3');
  assert.equal(tierFor(0, 32, true), 'T3');
});

import { extractToolCalls, normalizePatches, stripLineNumbers } from '../src/tools/shim.ts';
import { findByTag } from '../src/catalog.ts';

test('прокладка: вызов инструмента, записанный текстом', () => {
  const allowed = ['read_file', 'submit_patches'];
  const a = extractToolCalls('Сначала посмотрю файл.\n```json\n{"name": "read_file", "arguments": {"path": "src/a.js"}}\n```', allowed, 'submit_patches');
  assert.equal(a[0]?.function.name, 'read_file');
  assert.deepEqual(a[0]?.function.arguments, { path: 'src/a.js' });
  const b = extractToolCalls('{"patches": [{"file": "a.js", "search": "x", "replace": "y"}]}', allowed, 'submit_patches');
  assert.equal(b[0]?.function.name, 'submit_patches');
  assert.equal(extractToolCalls('просто текст {без json}', allowed, 'submit_patches').length, 0);
});

test('прокладка: заплатки строкой JSON и с чужими именами полей', () => {
  const s = normalizePatches({ patches: '[{"path": "a.js", "old_str": "x", "new_str": "y"}]' });
  assert.deepEqual(s, [{ file: 'a.js', search: 'x', replace: 'y' }]);
  assert.deepEqual(normalizePatches({ file: 'b.js', search: '', replace: 'z' }), [{ file: 'b.js', search: '', replace: 'z' }]);
  assert.deepEqual(normalizePatches({ patches: { file: 'c.js', find: 'a', replacement: 'b' } }), [{ file: 'c.js', search: 'a', replace: 'b' }]);
  assert.equal(stripLineNumbers('   3| const a = 1;\n   4| return a;'), 'const a = 1;\nreturn a;');
  assert.equal(stripLineNumbers('const a = 1;'), 'const a = 1;');
});

test('каталог узнаёт варианты сжатия по тегу', () => {
  const cat = loadCatalog();
  assert.equal(findByTag(cat, 'qwen2.5-coder:7b-instruct-q8_0')?.id, 'qwen2.5-coder-7b');
  assert.equal(findByTag(cat, 'llama3.1:8b')?.id, 'llama3.1-8b');
  assert.equal(findByTag(cat, 'qwen3.6:latest')?.id, 'qwen3.6-35b-a3b');
});

import { fuzzyReplace } from '../src/tools/patch.ts';

test('заплатки: случай из реального прогона — 6 пробелов вместо 4', () => {
  const dir = tmp();
  const src = "export function slugify(title) {\n  return title\n    .trim()\n    .replace(/[^a-zA-Z0-9]+/g, '-');\n}\n";
  writeFileSync(path.join(dir, 'text.js'), src);
  const r = applyPatches(dir, [
    { file: 'text.js', search: "      .replace(/[^a-zA-Z0-9]+/g, '-');", replace: "      .replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();" },
  ]);
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(readFileSync(path.join(dir, 'text.js'), 'utf8'), src.replace("'-');", "'-').toLowerCase();"));
});

test('заплатки: мягкое совпадение не срабатывает, если строк несколько', () => {
  assert.equal(fuzzyReplace('  a\nb\n    a\n', 'a', 'x').kind, 'many');
  assert.equal(fuzzyReplace('a\nb\n', 'c', 'x').kind, 'none');
});

import { canRun, isMoE } from '../src/team.ts';
import { canSplit } from '../src/pipeline.ts';

test('MoE-модели запускаются с частичной выгрузкой в RAM без флага, плотные — нет', () => {
  const cat = loadCatalog();
  const q36 = cat.find((m) => m.id === 'qwen3.6-35b-a3b')!;
  const q38 = cat.find((m) => m.id === 'qwen3.8-27b')!;
  const rtx5080: Hardware = { ...hw(15.9, 'T2'), ramTotalGb: 31.1 };
  assert.equal(isMoE(q36), true);
  assert.equal(canRun(q36, rtx5080, 16384), true);
  assert.equal(isMoE(q38), false);
  assert.equal(canRun(q38, rtx5080, 16384), false);
  assert.equal(canRun(q38, rtx5080, 16384, true), true);
});

test('маленькую задачу с замороженным тестом не дробим', () => {
  const g = new TaskGraph([{ ...task('T1'), freeze: ['a.test.js'] }, { ...task('T2', [], ['a.js', 'b.js']), size: 'M' }, task('T3', [], ['c.js'])]);
  assert.equal(canSplit(g.get('T1')), false);
  assert.equal(canSplit(g.get('T2')), true);
  assert.equal(canSplit(g.get('T3')), false, 'S-задача в одном файле — дробить нечего');
});

test('план: «сначала тест» разворачивается один раз, даже при повторной проверке', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'a.js'), '');
  const once = validatePlan({ goal: 'x', tasks: [{ ...task('A'), testFirst: true, accept: { tests: ['n.test.js'], commands: [] } }] }, dir, 'T3');
  const twice = validatePlan(once.plan, dir, 'T3');
  assert.equal(twice.ok, true, twice.errors.join('\n'));
  assert.deepEqual(twice.plan.tasks.map((t) => t.id), ['A-test', 'A']);
});
