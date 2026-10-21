// Прямой режим: один JSON по схеме, быстрые поправки внутри одного вызова.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runDirect, canGoDirect, buildTaskPrompt } from '../src/agent.ts';
import { MockRuntime } from '../src/runtime/mock.ts';
import { TaskGraph } from '../src/graph.ts';

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ay-direct-'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src/a.js'), 'export const f = () => {\n    return 1;\n};\n');
  const g = new TaskGraph([
    { id: 'T1', type: 'edit', title: 'вернуть 2', brief: 'f должна возвращать 2', dependsOn: [], files: ['src/a.js'], accept: { tests: ['test/a.test.js'], commands: [] }, size: 'S', freeze: ['test/a.test.js'] },
  ]);
  return { dir, task: g.get('T1') };
}

test('прямой режим: ошибка в заплатке исправляется внутри одного вызова, со схемой и без инструментов', async () => {
  const { dir, task } = setup();
  const answers = [
    { patches: [{ file: 'src/a.js', search: 'return 7;', replace: 'return 2;' }], note: 'мимо' },
    { patches: [{ file: 'src/a.js', search: '  return 1;', replace: '  return 2;' }], note: 'исправил' },
  ];
  let i = 0;
  const rt = new MockRuntime([], (req) => {
    assert.ok(req.format, 'запрос идёт со схемой ответа');
    assert.equal(req.tools, undefined, 'инструменты не передаются');
    return { role: 'assistant', content: JSON.stringify(answers[i++]) };
  });
  const r = await runDirect(rt, { task, role: 'coder', modelTag: 'm', workdir: dir, repoMapText: '', maxSteps: 10, numCtx: 8192 });
  assert.equal(r.ok, true, r.error ?? "");
  assert.equal(r.steps, 2);
  assert.match(rt.calls[1]!.messages.filter((m) => m.role === 'user').at(-1)!.content, /фрагмент не найден/);
  assert.equal(readFileSync(path.join(dir, 'src/a.js'), 'utf8'), 'export const f = () => {\n    return 2;\n};\n', 'отступ подправлен мягким совпадением');
});

test('прямой режим: файл в запросе без номеров строк, тест помечен замороженным', () => {
  const { dir, task } = setup();
  mkdirSync(path.join(dir, 'test'));
  writeFileSync(path.join(dir, 'test/a.test.js'), 'test()\n');
  const prompt = buildTaskPrompt({ task, role: 'coder', modelTag: 'm', workdir: dir, repoMapText: '', maxSteps: 10, numCtx: 8192, direct: true });
  assert.match(prompt, /```js\nexport const f = \(\) => \{\n    return 1;/);
  assert.doesNotMatch(prompt, /\d\| /);
  assert.match(prompt, /test\/a\.test\.js \(ЗАМОРОЖЕН/);
  assert.match(prompt, /Верни JSON/);
});

test('прямой режим включается, только когда файлы для правки известны', () => {
  const { dir, task } = setup();
  assert.equal(canGoDirect('coder', task, dir), true);
  assert.equal(canGoDirect('coder', { ...task, files: [] }, dir), false);
  assert.equal(canGoDirect('coder', { ...task, files: ['src/nope.js'] }, dir), false);
  assert.equal(canGoDirect('reviewer', task, dir), true);
});

import { foreignFramework } from '../src/checks.ts';
import { applyPatches } from '../src/tools/patch.ts';

test('тест в чужом стиле (Jest в проекте на node:test) — не красный, а сломанный', () => {
  assert.ok(foreignFramework('ReferenceError: require is not defined in ES module scope'));
  assert.ok(foreignFramework('ReferenceError: describe is not defined'));
  assert.equal(foreignFramework("SyntaxError: The requested module '../src/promo.js' does not provide an export named 'applyPromo'"), null);
});

test('целиком можно переписать свой новый файл и небольшой чужой; большой чужой — только фрагментами', () => {
  const { dir } = setup();
  writeFileSync(path.join(dir, 'src/new.js'), 'old');
  assert.equal(applyPatches(dir, [{ file: 'src/new.js', search: '', replace: 'new' }]).ok, true);
  assert.equal(readFileSync(path.join(dir, 'src/new.js'), 'utf8'), 'new');
  const big = Array.from({ length: 400 }, (_, i) => `const a${i} = ${i};`).join('\n');
  writeFileSync(path.join(dir, 'src/big.js'), big);
  const r = applyPatches(dir, [{ file: 'src/big.js', search: '', replace: 'x' }]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0]!, /файл большой/);
  assert.equal(applyPatches(dir, [{ file: 'src/big.js', search: '', replace: 'x' }], [], ['src/big.js']).ok, true);
});

test('полная перезапись файла с кодом, потерявшая больше половины строк, отклоняется', () => {
  const { dir } = setup();
  const code = Array.from({ length: 40 }, (_, i) => `export const a${i} = ${i};`).join('\n');
  writeFileSync(path.join(dir, 'src/many.js'), code);
  const r = applyPatches(dir, [{ file: 'src/many.js', search: '', replace: 'export const a0 = 0;\n// ... остальное без изменений\n' }]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0]!, /часть файла потеряна/);
  assert.equal(readFileSync(path.join(dir, 'src/many.js'), 'utf8'), code);
});

test('стили не упираются в лимит строк кода: переписанный CSS на 130 строк — 0 строк кода', () => {
  const { dir } = setup();
  writeFileSync(path.join(dir, 'src/a.css'), '.a { color: red; }\n');
  const css = Array.from({ length: 130 }, (_, i) => `.c${i} { padding: ${i}px; }`).join('\n');
  const r = applyPatches(dir, [{ file: 'src/a.css', search: '', replace: css }]);
  assert.equal(r.ok, true);
  assert.equal(r.changedLines, 0);
});

test('тестировщик видит цель дословно, пример теста проекта и объяснение «сначала тест»', () => {
  const { dir } = setup();
  mkdirSync(path.join(dir, 'test'));
  writeFileSync(path.join(dir, 'test/a.test.js'), "import { test } from 'node:test';\n");
  const g = new TaskGraph([
    { id: 'T1', type: 'test', title: 'тест', brief: 'тест', dependsOn: [], files: ['test/b.test.js'], newFiles: ['test/b.test.js'], accept: { tests: ['test/b.test.js'], commands: [] }, size: 'S' },
    { id: 'T2', type: 'edit', title: 'код', brief: 'код', dependsOn: ['T1'], files: ['src/a.js'], accept: { tests: ['test/b.test.js'], commands: [] }, size: 'S' },
  ]);
  const prompt = buildTaskPrompt({ task: g.get('T1'), role: 'tester', modelTag: 'm', workdir: dir, repoMapText: '', maxSteps: 5, numCtx: 8192, direct: true, goal: 'неизвестный код бросает ошибку' });
  assert.match(prompt, /дословно от человека[^\n]*\n\nнеизвестный код бросает ошибку/);
  assert.match(prompt, /Пример теста этого проекта \(test\/a\.test\.js\)/);
  assert.match(prompt, /сначала тест/);
  assert.deepEqual(g.get('T2').frozenFiles, ['test/b.test.js'], 'тест из задачи-теста заморожен для кодера');
});

test('прямой режим: одинаковый повтор после замечания — сразу стоп', async () => {
  const { dir, task } = setup();
  const same = JSON.stringify({ patches: [{ file: 'src/a.js', search: 'нет такого', replace: 'x' }], note: '' });
  const rt = new MockRuntime([], () => ({ role: 'assistant', content: same }));
  const r = await runDirect(rt, { task, role: 'coder', modelTag: 'm', workdir: dir, repoMapText: '', maxSteps: 5, numCtx: 8192 });
  assert.equal(r.ok, false);
  assert.equal(rt.calls.length, 2, 'не тратим ещё две попытки на тот же ответ');
});
