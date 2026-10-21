// Самостоятельность: прежде чем звать человека, конвейер сам меняет способ —
// файл целиком вместо непопадающих заплаток, разрешает соседний файл, просит другой подход.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWebRepo } from '../src/demo.ts';
import { MockRuntime } from '../src/runtime/mock.ts';
import { Pipeline } from '../src/pipeline.ts';
import { loadCatalog } from '../src/catalog.ts';
import { Stats } from '../src/stats.ts';
import type { ChatMessage, ChatRequest } from '../src/runtime/types.ts';
import type { Hardware } from '../src/types.ts';

const HW: Hardware = { gpuName: 'test', vramTotalGb: 48, vramFreeGb: 48, ramTotalGb: 64, ramFreeGb: 32, cpuCores: 8, unifiedMemory: false, tier: 'T3' };
const PAGE = 'src/pages/address-list/ui/AddressListPage.tsx';
const CSS = 'src/shared/ui/generated.css';
const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });

function web(): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'ay-self-')), 'web');
  createWebRepo(dir);
  return dir;
}

function run(repo: string, script: (system: string, user: string) => ChatMessage) {
  const rt = new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], (req: ChatRequest) => {
    const system = req.messages[0]?.content ?? '';
    const user = req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    return script(system, user);
  });
  return new Pipeline({ repo, goal: 'заголовок адресов: Адреса доставки', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, autoApply: true }).run();
}

const plan = (files: string[]) => json({ understanding: 'x', tasks: [{ id: 'T1', type: 'edit', title: 'Заголовок', brief: 'Адреса → Адреса доставки', dependsOn: [], files, accept: { tests: [], commands: [] }, size: 'S' }] });

test('заплатки не попадают в файл — следующая попытка присылает файл целиком и проходит', async () => {
  const repo = web();
  const original = readFileSync(path.join(repo, PAGE), 'utf8');
  let whole = false;
  const res = await run(repo, (system, user) => {
    if (system.includes('планировщик')) return plan([PAGE]);
    if (/присылай ЦЕЛИКОМ/.test(user)) {
      whole = true;
      return json({ patches: [{ file: PAGE, search: '', replace: original.replace('<h1>Адреса</h1>', '<h1>Адреса доставки</h1>') }], note: 'целиком' });
    }
    return json({ patches: [{ file: PAGE, search: '<h1> Адреса </h1>', replace: '<h1>Адреса доставки</h1>' }], note: 'промах' });
  });
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.ok(whole, journal);
  assert.deepEqual(res.done, ['T1'], journal);
  assert.match(journal, /пришлёт файл целиком/);
  assert.match(readFileSync(path.join(repo, PAGE), 'utf8'), /Адреса доставки/);
});

test('правке нужен соседний файл, которого нет в задаче, — программа разрешает, а не возвращает работу', async () => {
  const repo = web();
  const res = await run(repo, (system) => {
    if (system.includes('планировщик')) return plan([PAGE]);
    return json({
      patches: [
        { file: PAGE, search: '<h1>Адреса</h1>', replace: '<h1 className="af-title">Адреса доставки</h1>' },
        { file: CSS, search: '.af-muted { color: #8a97a8; }', replace: '.af-muted { color: #8a97a8; }\n.af-title { letter-spacing: .02em; }' },
      ],
      note: 'ok',
    });
  });
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(res.done, ['T1'], journal);
  assert.match(journal, /понадобились ещё файлы \(src\/shared\/ui\/generated\.css\)/);
  assert.match(readFileSync(path.join(repo, CSS), 'utf8'), /af-title/);
});

test('обычные способы не помогли — планировщик предлагает другой подход, и он срабатывает без человека', async () => {
  const repo = web();
  const res = await run(repo, (system, user) => {
    if (system.includes('планировщик')) {
      if (/Прежний подход не сработал/.test(user)) {
        return json({ understanding: 'другой путь', tasks: [{ id: 'A', type: 'edit', title: 'Заголовок в самой странице', brief: 'Адреса → Адреса доставки', dependsOn: [], files: [PAGE], accept: { tests: [], commands: [] }, size: 'S' }] });
      }
      return plan(['app/layout.tsx']); // первый план — мимо: заголовка в layout нет
    }
    if (/## Задача\s+T1\.1:/.test(user)) return json({ patches: [{ file: PAGE, search: '<h1>Адреса</h1>', replace: '<h1>Адреса доставки</h1>' }], note: 'ok' });
    return json({ patches: [{ file: 'app/layout.tsx', search: '<h1>Адреса</h1>', replace: 'x' }], note: 'не нашёл' });
  });
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(res.human, [], journal);
  assert.match(journal, /прошу планировщика предложить другой подход/);
  assert.match(journal, /прежний подход не сработал — планировщик предложил другой: T1\.1/);
  assert.match(readFileSync(path.join(repo, PAGE), 'utf8'), /Адреса доставки/);
});
