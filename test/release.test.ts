// Конец прогона: модели, с которыми он работал, выгружаются из видеопамяти сразу, а не через keep_alive Ollama.

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
import { startServer } from '../src/server.ts';
import type { ChatMessage, ChatRequest, ChatResponse } from '../src/runtime/types.ts';
import type { Hardware } from '../src/types.ts';

const HW: Hardware = { gpuName: 'test', vramTotalGb: 16, vramFreeGb: 16, ramTotalGb: 32, ramFreeGb: 24, cpuCores: 8, unifiedMemory: false, tier: 'T2' };
const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
const PAGE = 'src/pages/address-list/ui/AddressListPage.tsx';
const PLAN = [{ id: 'T1', type: 'edit', title: 'Заголовок', brief: 'Поменять заголовок', dependsOn: [], files: [PAGE], accept: { tests: [], commands: [] }, size: 'S' }];
const INSTALLED = [{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }];

function web(): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'ay-release-')), 'web');
  createWebRepo(dir);
  return dir;
}

/** Как Ollama: в памяти может быть несколько моделей, запрос к модели сам её загружает. */
class ResidentRuntime extends MockRuntime {
  resident = new Set<string>();
  unloaded: string[] = [];
  hang = false;
  started = 0;
  override async loaded(): Promise<string[]> {
    return [...this.resident];
  }
  override async load(tag: string): Promise<number> {
    this.resident.add(tag);
    return 5;
  }
  override async unload(tag: string): Promise<void> {
    this.resident.delete(tag);
    this.unloaded.push(tag);
  }
  override async chat(req: ChatRequest): Promise<ChatResponse> {
    this.resident.add(req.model);
    const system = req.messages[0]?.content ?? '';
    if (this.hang && !/планировщик|приёмщик|ревьюер/.test(system)) {
      this.started += 1;
      return new Promise<ChatResponse>((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return super.chat(req);
  }
}

const script = (rt: () => ResidentRuntime) => (req: ChatRequest): ChatMessage => {
  const system = req.messages[0]?.content ?? '';
  if (system.includes('приёмщик')) {
    // пока шла приёмка, другая программа загрузила свою модель — её прогон трогать не должен
    rt().resident.add('llama3.2:3b');
    return json({ achieved: true, missing: [], tasks: [] });
  }
  if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
  if (system.includes('планировщик')) return json({ understanding: 'x', tasks: PLAN });
  return json({ patches: [{ file: PAGE, search: '<h1>', replace: '<h1 title="Адреса">' }], note: 'заголовок' });
};

test('прогон закончен — его модели выгружены из видеопамяти, чужая модель осталась', async () => {
  const repo = web();
  let rt!: ResidentRuntime;
  rt = new ResidentRuntime(INSTALLED, script(() => rt));
  const r = await new Pipeline({ repo, goal: 'заголовок', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, sampling: 1 }).run();
  assert.ok(r.done.includes('T1'), JSON.stringify(r.human));
  assert.ok(rt.unloaded.length > 0, 'что-то выгружено');
  assert.deepEqual(rt.resident.size ? [...rt.resident] : [], ['llama3.2:3b'], 'в памяти только чужая модель');
  const journal = readFileSync(path.join(r.runDir, 'journal.txt'), 'utf8');
  assert.match(journal, /Прогон закончен — выгрузил из видеопамяти: qwen3\.6:latest/);
});

test('«Стоп» — модели прогона тоже выгружены', async () => {
  const repo = web();
  let rt!: ResidentRuntime;
  rt = new ResidentRuntime(INSTALLED, script(() => rt));
  rt.hang = true;
  const p = new Pipeline({ repo, goal: 'заголовок', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, sampling: 1 });
  const res = p.run();
  for (let i = 0; i < 300 && rt.started === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(rt.started, 1, 'исполнитель начал работу');
  p.stop();
  await res;
  assert.deepEqual([...rt.resident], [], 'видеопамять свободна');
});

test('выход из приложения: сервер останавливает прогон и ждёт, пока тот выгрузит модели', async () => {
  const repo = web();
  let rt!: ResidentRuntime;
  rt = new ResidentRuntime(INSTALLED, script(() => rt));
  rt.hang = true;
  const srv = await startServer({ runtimeFactory: () => rt, statsPath: null, hardware: async () => ({ ...HW }) });
  try {
    const call = (p: string, body: unknown) => fetch(`http://127.0.0.1:${srv.port}${p}`, { method: 'POST', headers: { 'x-ay-token': srv.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const started = await call('/api/run', { repo, goal: 'заголовок', approve: false, mock: true });
    assert.equal(started.status, 200, await started.clone().text());
    for (let i = 0; i < 300 && rt.started === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(rt.started, 1, 'исполнитель начал работу');
    const t0 = Date.now();
    const bye = await call('/api/shutdown', {});
    assert.equal(bye.status, 200);
    assert.ok(Date.now() - t0 < 10_000);
    assert.deepEqual([...rt.resident], [], 'к ответу на /api/shutdown видеопамять уже свободна');
  } finally {
    await srv.close();
  }
});
