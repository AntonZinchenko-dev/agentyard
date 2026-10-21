// Правка по образцу: один файл правит модель, остальные однотипные — программа.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { entityPairs, matchFiles, replicate, substitute } from '../src/replicate.ts';
import { createWebRepo } from '../src/demo.ts';
import { buildRepoMap } from '../src/repomap.ts';
import { MockRuntime } from '../src/runtime/mock.ts';
import { Pipeline } from '../src/pipeline.ts';
import { loadCatalog } from '../src/catalog.ts';
import { Stats } from '../src/stats.ts';
import type { ChatMessage, ChatRequest } from '../src/runtime/types.ts';
import type { Hardware } from '../src/types.ts';

const HW: Hardware = { gpuName: 'test', vramTotalGb: 48, vramFreeGb: 48, ramTotalGb: 64, ramFreeGb: 32, cpuCores: 8, unifiedMemory: false, tier: 'T3' };
const GLOB = 'src/pages/*/ui/*ListPage.tsx';

test('имя сущности из пути во всех написаниях', () => {
  const pairs = entityPairs(GLOB, 'src/pages/address-list/ui/AddressListPage.tsx', 'src/pages/order-list/ui/OrderListPage.tsx');
  assert.deepEqual(new Map(pairs).get('Address'), 'Order');
  assert.deepEqual(new Map(pairs).get('address'), 'order');
  assert.equal(substitute('href="/addresses/new" AddressListPage useAddressesList', pairs), 'href="/orders/new" OrderListPage useOrdersList');
  const cat = entityPairs(GLOB, 'src/pages/address-list/ui/AddressListPage.tsx', 'src/pages/category-list/ui/CategoryListPage.tsx');
  assert.equal(substitute('/addresses/ Addresses', cat), '/categories/ Categories');
});

test('повтор: общий фрагмент встаёт везде, своё — с подстановкой имени, несовпавшее — в отказ', () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'ay-rep-')), 'web');
  createWebRepo(dir);
  const files = matchFiles(GLOB, buildRepoMap(dir).files);
  assert.equal(files.length, 6);
  const example = 'src/pages/address-list/ui/AddressListPage.tsx';
  const targets = files.filter((f) => f !== example);
  // общий для всех фрагмент
  const r1 = replicate(dir, GLOB, example, [{ file: example, search: '          Добавить\n', replace: '          Создать\n' }], targets);
  assert.equal(r1.applied.length, 5);
  assert.equal(r1.failed.length, 0);
  for (const f of files.filter((f) => f !== example)) assert.match(readFileSync(path.join(dir, f), 'utf8'), /Создать/);
  // фрагмент с именем сущности: export function AddressListPage → OrderListPage и т.д.
  const r2 = replicate(dir, GLOB, example, [{ file: example, search: 'export function AddressListPage() {', replace: 'export function AddressListPage(): JSX.Element {' }], targets);
  assert.equal(r2.applied.length, 5);
  assert.match(readFileSync(path.join(dir, 'src/pages/user-list/ui/UserListPage.tsx'), 'utf8'), /UserListPage\(\): JSX\.Element/);
  // ссылка с именем сущности во множественном числе — тоже повторяется
  const r4 = replicate(dir, GLOB, example, [{ file: example, search: 'href="/addresses/new"', replace: 'href="/addresses/create"' }], targets);
  assert.equal(r4.applied.length, 5, r4.failed.join(','));
  assert.match(readFileSync(path.join(dir, 'src/pages/order-list/ui/OrderListPage.tsx'), 'utf8'), /href="\/orders\/create"/);
  // заголовок на русском у каждой страницы свой — повторить нельзя, все в отказ
  const r3 = replicate(dir, GLOB, example, [{ file: example, search: '<h1>Адреса</h1>', replace: '<h1>Адреса!</h1>' }], targets);
  assert.equal(r3.failed.length, 5);
});

test('прогон: «везде кнопку Добавить переименуй в Создать» — одна задача, правка по образцу на все страницы', async () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'ay-rep2-')), 'web');
  createWebRepo(dir);
  let coderCalls = 0;
  const script = (req: ChatRequest): ChatMessage => {
    const system = req.messages[0]?.content ?? '';
    const user = req.messages[1]?.content ?? '';
    const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
    if (system.includes('планировщик')) {
      return json({
        understanding: 'На всех страницах списков кнопка «Добавить» станет «Создать».',
        tasks: [{ id: 'T1', type: 'edit', title: 'Переименовать кнопку', brief: 'Добавить → Создать', dependsOn: [], files: ['src/pages/address-list/ui/AddressListPage.tsx'], similar: GLOB, accept: { tests: [], commands: [] }, size: 'S' }],
      });
    }
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    if (system.includes('ревьюер')) {
      assert.match(user, /повторит эту правку ещё в 5 однотипных файлах/);
      return json({ verdict: 'approve', reasons: [] });
    }
    if (system.includes('кодер')) {
      coderCalls += 1;
      assert.match(user, /Правка по образцу/);
      return json({ patches: [{ file: 'src/pages/address-list/ui/AddressListPage.tsx', search: '          Добавить\n', replace: '          Создать\n' }], note: 'ok' });
    }
    return json({});
  };
  const rt = new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], script);
  const res = await new Pipeline({ repo: dir, goal: 'везде где кнопка Добавить пусть будет Создать', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, autoApply: true }).run();
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(res.done, ['T1'], journal);
  assert.equal(coderCalls, 1, journal);
  assert.match(journal, /программа повторила ещё в 5 файл/);
  assert.match(journal, /Ревьюер .* принял T1/, journal);
  assert.equal(res.changes.length, 6);
  for (const e of ['address', 'user', 'order', 'product', 'payment', 'review']) {
    const t = readFileSync(path.join(dir, `src/pages/${e}-list/ui/${e[0]!.toUpperCase()}${e.slice(1)}ListPage.tsx`), 'utf8');
    assert.ok(t.includes('Создать') && !t.includes('Добавить'), e);
  }
});
