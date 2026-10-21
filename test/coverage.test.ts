// Полнота теста: требования цели ↔ строки теста. Повтор слабого теста из прогона 19.10 14:52.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkCoverage, goalLiterals, quoteFound } from '../src/coverage.ts';
import { createFeatureRepo, FEATURE_GOAL, PROMO_COVERAGE, PROMO_TEST, PROMO_CODE } from '../src/demo.ts';
import { MockRuntime } from '../src/runtime/mock.ts';
import { Pipeline } from '../src/pipeline.ts';
import { loadCatalog } from '../src/catalog.ts';
import { Stats } from '../src/stats.ts';
import type { ChatMessage, ChatRequest } from '../src/runtime/types.ts';
import type { Hardware } from '../src/types.ts';

const HW: Hardware = { gpuName: 'test', vramTotalGb: 48, vramFreeGb: 48, ramTotalGb: 64, ramFreeGb: 32, cpuCores: 8, unifiedMemory: false, tier: 'T3' };

// тест, который реально написал gpt-oss: нет обычного случая FIX500
const WEAK_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPromo } from '../src/promo.js';

test('applyPromo works', () => {
  assert.equal(applyPromo(1000, 'SAVE10'), 900);
  assert.equal(applyPromo(500, 'FIX500'), 0);
  assert.equal(applyPromo(400, 'FIX500'), 0);
  assert.throws(() => applyPromo(2000, 'UNKNOWN'), /Неизвестный промокод/);
});
`;

test('значения из цели: коды и тексты, без путей файлов', () => {
  const lits = goalLiterals(FEATURE_GOAL);
  assert.ok(lits.includes('SAVE10'));
  assert.ok(lits.includes('FIX500'));
  assert.ok(lits.includes('Неизвестный промокод'));
  assert.ok(!lits.some((l) => l.includes('promo.js')));
});

test('цитата сверяется с тестом без учёта пробелов и точки с запятой', () => {
  assert.ok(quoteFound("assert.equal(applyPromo(1000,  'SAVE10'), 900)", WEAK_TEST));
  assert.ok(!quoteFound("assert.equal(applyPromo(1200, 'FIX500'), 700);", WEAK_TEST));
});

test('слабый тест: обычный случай FIX500 без проверки, выдуманная цитата ловится', () => {
  const v = checkCoverage(
    [
      { requirement: 'SAVE10 — скидка 10%', check: "assert.equal(applyPromo(1000, 'SAVE10'), 900);" },
      { requirement: 'FIX500 — минус 500', check: '' },
      { requirement: 'FIX500 — не ниже нуля', check: "assert.equal(applyPromo(1200, 'FIX500'), 700);" },
    ],
    WEAK_TEST,
    FEATURE_GOAL,
  );
  assert.deepEqual(v.uncovered, ['FIX500 — минус 500']);
  assert.equal(v.badQuotes.length, 1);
  assert.deepEqual(v.missingLiterals, []);
});

test('полный тест учебного магазина покрыт по всем пунктам', () => {
  const v = checkCoverage(PROMO_COVERAGE.requirements, PROMO_TEST, FEATURE_GOAL);
  assert.deepEqual(v, { badQuotes: [], uncovered: [], missingLiterals: [] });
});

test('прогон: ревьюер находит дыру в тесте → тестировщик дописывает → в отчёте таблица покрытия', async () => {
  const repo = path.join(mkdtempSync(path.join(tmpdir(), 'ay-cov-')), 'shop');
  createFeatureRepo(repo);
  let testerCalls = 0;
  let reviewQuoteRetries = 0;
  const script = (req: ChatRequest): ChatMessage => {
    const system = req.messages[0]?.content ?? '';
    const user = req.messages[1]?.content ?? '';
    const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
    if (system.includes('планировщик')) {
      return json({ tasks: [{ id: 'T1', type: 'edit', title: 'Промокоды', brief: 'applyPromo', dependsOn: [], files: ['src/promo.js'], newFiles: ['src/promo.js'], accept: { tests: ['test/promo.test.js'], commands: [] }, size: 'S', testFirst: true }] });
    }
    if (system.includes('тестировщик')) {
      testerCalls += 1;
      return json({ patches: [{ file: 'test/promo.test.js', search: '', replace: testerCalls === 1 ? WEAK_TEST : PROMO_TEST }], note: 'тест' });
    }
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('кодер')) return json({ patches: [{ file: 'src/promo.js', search: '', replace: PROMO_CODE }], note: 'код' });
    return json({});
  };
  // ревьюер теста: смотрит на diff в запросе и честно отвечает по пунктам
  const reviewer = (req: ChatRequest): ChatMessage | null => {
    const system = req.messages[0]?.content ?? '';
    const user = req.messages[1]?.content ?? '';
    if (!system.includes('ревьюер') || !user.includes('"requirements"')) return null;
    const last = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    if (/Этих строк нет в тесте/.test(last)) reviewQuoteRetries += 1;
    const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
    if (user.includes("applyPromo(500, 'FIX500')")) {
      // первая версия: сначала выдумывает цитату, после замечания честно оставляет пусто
      const invented = !/Этих строк нет в тесте/.test(last);
      return json({
        requirements: [
          { requirement: 'SAVE10 — скидка 10%', check: "assert.equal(applyPromo(1000, 'SAVE10'), 900);" },
          { requirement: 'FIX500 — минус 500', check: invented ? "assert.equal(applyPromo(1200, 'FIX500'), 700);" : '' },
          { requirement: 'FIX500 — не ниже нуля', check: "assert.equal(applyPromo(400, 'FIX500'), 0);" },
          { requirement: 'Ошибка «Неизвестный промокод»', check: "assert.throws(() => applyPromo(2000, 'UNKNOWN'), /Неизвестный промокод/);" },
        ],
        verdict: 'approve',
        reasons: [],
      });
    }
    return json(PROMO_COVERAGE);
  };
  const rt = new MockRuntime(
    [
      { tag: 'qwen3.6:latest', sizeGb: 23 },
      { tag: 'gpt-oss:20b', sizeGb: 14 },
    ],
    (req) => reviewer(req) ?? script(req),
  );
  const res = await new Pipeline({ repo, goal: FEATURE_GOAL, runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true }).run();
  assert.deepEqual(res.done.sort(), ['T1', 'T1-test']);
  assert.equal(testerCalls, 2, 'тестировщик должен был дописать тест');
  assert.ok(reviewQuoteRetries >= 1, 'выдуманная цитата должна была вернуться ревьюеру');
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.match(journal, /вернул T1-test: Нет проверки для требования: FIX500 — минус 500/);
  assert.match(journal, /Требований из цели: 4, у каждого есть проверка в тесте/);
  const report = readFileSync(path.join(res.runDir, 'report.md'), 'utf8');
  assert.match(report, /## Какие требования проверяют тесты/);
  assert.match(report, /applyPromo\(1200, 'FIX500'\), 700/);
});
