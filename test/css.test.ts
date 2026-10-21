// Правки CSS, которые на экране не проявятся: их перебивает более точное правило.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cssOverrideWarnings } from '../src/css.ts';

const BEFORE = `.af-btn { padding: 7px 14px; background: #fff; }
.af-btn.primary { background: #2f6fdb; border-color: #2f6fdb; color: #fff; }
.af-btn:hover { border-color: #999; }
.af-table th { color: #46556a; }
@media (prefers-color-scheme: dark) { .af-btn.primary { background: #123; } }
`;

test('покрасили общий класс — более точное правило перебивает фон', () => {
  const w = cssOverrideWarnings(BEFORE, BEFORE.replace('background: #fff', 'background: #d32f2f'));
  assert.equal(w.length, 1);
  assert.match(w[0]!, /\.af-btn \{ background: #d32f2f \}.*\.af-btn\.primary.*background: #2f6fdb/);
});

test('поменяли сам точный селектор — предупреждений нет; рамку у :hover — тоже перебивает', () => {
  assert.deepEqual(cssOverrideWarnings(BEFORE, BEFORE.replace('.af-btn.primary { background: #2f6fdb', '.af-btn.primary { background: #d32f2f')), []);
  const w = cssOverrideWarnings(BEFORE, BEFORE.replace('padding: 7px 14px;', 'padding: 7px 14px; border-color: red;'));
  assert.ok(w.some((x) => x.includes('.af-btn:hover')));
});

test('не путает похожие имена: .af-btn и .af-btn-group — разные классы', () => {
  const css = '.af-btn { color: #000; }\n.af-btn-group { color: #333; }\n';
  assert.deepEqual(cssOverrideWarnings(css, css.replace('color: #000', 'color: red')), []);
});

test('факты о цвете: какие кнопки красные, какие нет', async () => {
  const { colorFacts } = await import('../src/css.ts');
  const css = '.af-btn { background: #fff; }\n.af-btn.primary { background: #2f6fdb; }\n.af-btn.danger { background: #c0392b; }\n.af-btn:hover { background: #eee; }\n';
  const [f] = colorFacts('сделай кнопки красными', css);
  assert.match(f!, /красный — \.af-btn\.danger/);
  assert.match(f!, /НЕ красный — \.af-btn \(#fff\), \.af-btn\.primary \(#2f6fdb\)/);
  assert.deepEqual(colorFacts('сделай кнопки побольше', css), [], 'нет цвета в цели — нет фактов');
  assert.match(colorFacts('make buttons blue', css)[0]!, /синий — \.af-btn\.primary/);
});
