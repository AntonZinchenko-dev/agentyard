// Экзамен «пьяный тест»: оценщики должны валить нетронутый проект и пропускать правильно сделанный.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SCENARIOS, parseCss, cssValue, parseColor, isReddish, runEval, renderEval } from '../src/eval.ts';
import { isFixTestsGoal } from '../src/planner.ts';
import { PROMO_CODE } from '../src/demo.ts';
import type { PipelineResult } from '../src/pipeline.ts';

const edit = (dir: string, f: string, fn: (s: string) => string) => writeFileSync(path.join(dir, f), fn(readFileSync(path.join(dir, f), 'utf8')));

/** Как выглядит правильно сделанная работа по каждому сценарию. */
const IDEAL: Record<string, (dir: string) => void> = {
  'web-red-buttons': (d) => edit(d, 'src/shared/ui/generated.css', (s) => `${s}\n.af-btn.primary { background: var(--danger); }\n:root { --danger: #d32f2f; }\n`),
  'web-sticky-header': (d) => edit(d, 'src/shared/ui/generated.css', (s) => `${s}\n.af-table th { position: sticky; top: 0; }\n`),
  'web-dark-theme': (d) => edit(d, 'src/shared/ui/generated.css', (s) => `${s}\n@media (prefers-color-scheme: dark) {\n  .af-page { background: #121417; color: #e6e8eb; }\n}\n`),
  'web-title': (d) => edit(d, 'src/pages/address-list/ui/AddressListPage.tsx', (s) => s.replace('<h1>Адреса</h1>', '<h1>Адреса доставки</h1>')),
  'web-rename-everywhere': (d) => {
    for (const e of ['address', 'user', 'order', 'product', 'payment', 'review']) edit(d, `src/pages/${e}-list/ui/${e[0]!.toUpperCase()}${e.slice(1)}ListPage.tsx`, (s) => s.replace('Добавить', 'Создать'));
  },
  'web-docker-port': (d) => edit(d, 'Dockerfile', (s) => s.replace(/3000/g, '8080')),
  'web-ui-kit': (d) => {
    edit(d, 'package.json', (s) => { const p = JSON.parse(s); return JSON.stringify({ ...p, dependencies: { ...p.dependencies, '@mantine/core': '^7.17.0' } }, null, 2); });
    for (const e of ['address', 'user', 'order', 'product', 'payment', 'review']) edit(d, `src/pages/${e}-list/ui/${e[0]!.toUpperCase()}${e.slice(1)}ListPage.tsx`, (s) => s.replace("import Link from 'next/link'", "import Link from 'next/link'\nimport { Button } from '@mantine/core'"));
  },
  'shop-promo': (d) => writeFileSync(path.join(d, 'src/promo.js'), PROMO_CODE),
  'demo-fix': (d) => {
    edit(d, 'src/price.js', (s) => s.replace('price * (percent / 100)', 'price * (1 - percent / 100)'));
    edit(d, 'src/text.js', (s) => s.replace(".replace(/[^a-zA-Z0-9]+/g, '-');", ".toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');"));
  },
};

const fake = (dir: string): PipelineResult => ({ runDir: dir, branch: 'x', done: ['T1'], human: [], reportPath: '', swaps: 0, seconds: 0, changes: [] });

test('цвета: hex, rgb, hsl, имена, переменные', () => {
  assert.ok(isReddish(parseColor('#d32f2f')));
  assert.ok(isReddish(parseColor('rgb(220, 38, 38)')));
  assert.ok(isReddish(parseColor('hsl(0, 70%, 50%)')));
  assert.ok(isReddish(parseColor('crimson')));
  assert.ok(!isReddish(parseColor('#2f6fdb')));
  assert.ok(!isReddish(parseColor('#ff9900')), 'оранжевый — не красный');
  const rules = parseCss(':root{--c:#e53935}\n.af-btn.primary{background:var(--c)}\n@media (prefers-color-scheme: dark){.af-btn.primary{background:#333}}');
  assert.equal(cssValue(rules, /^\.af-btn\.primary$/, ['background']), '#e53935');
});

test('«почини тесты» небрежно — это режим fix-tests; с другой работой — нет', () => {
  for (const g of ['fix-tests', 'тесты падают почини', 'почини тесты плз', 'тесты красные, сделай зелёными']) assert.ok(isFixTestsGoal(g), g);
  for (const g of ['добавь тесты на промокоды', 'почини тесты и добавь кнопку', 'сделай кнопки красными']) assert.ok(!isFixTestsGoal(g), g);
});

test('каждый оценщик валит нетронутый проект и пропускает правильно сделанный', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ay-eval-'));
  for (const sc of SCENARIOS) {
    const before = path.join(root, `${sc.id}-before`);
    sc.make(before);
    assert.equal((await sc.grade(before)).pass, false, `${sc.id}: нетронутый проект не должен сдаваться`);
    const after = path.join(root, `${sc.id}-after`);
    sc.make(after);
    IDEAL[sc.id]!(after);
    const g = await sc.grade(after);
    assert.equal(g.pass, true, `${sc.id}: ${g.why}`);
  }
});

test('экзамен целиком: «идеальный конвейер» сдаёт всё, ленивый — ничего; отчёт с баллом', async () => {
  const ideal = await runEval(mkdtempSync(path.join(tmpdir(), 'ay-eval-run-')), async (repo) => {
    IDEAL[path.basename(repo)]!(repo);
    return fake(repo);
  });
  assert.equal(ideal.filter((r) => r.pass).length, SCENARIOS.length);
  const lazy = await runEval(mkdtempSync(path.join(tmpdir(), 'ay-eval-run-')), async (repo) => fake(repo), ['web-red-buttons', 'demo-fix']);
  assert.equal(lazy.filter((r) => r.pass).length, 0);
  const md = renderEval(lazy, { models: 'm', started: 'now' });
  assert.match(md, /сдано 0 из 2/);
});
