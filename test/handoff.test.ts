// Задача у человека: открыть в редакторе → сохранить → программа проверяет, вливает, агенты идут дальше по цепочке.
// И откат применённого прогона из истории, даже если после него были свои коммиты.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWebRepo } from '../src/demo.ts';
import { MockRuntime } from '../src/runtime/mock.ts';
import { Pipeline } from '../src/pipeline.ts';
import { loadCatalog } from '../src/catalog.ts';
import { Stats } from '../src/stats.ts';
import { handoffChanges, humanDir, patchesFromDiff, prepareHandoff } from '../src/handoff.ts';
import { applyRun, readMeta, unapplyRun } from '../src/apply.ts';
import { startServer } from '../src/server.ts';
import type { ChatMessage, ChatRequest } from '../src/runtime/types.ts';
import type { Hardware } from '../src/types.ts';

process.env.AGENTYARD_EDITOR = 'none';
const HW: Hardware = { gpuName: 'test', vramTotalGb: 48, vramFreeGb: 48, ramTotalGb: 64, ramFreeGb: 32, cpuCores: 8, unifiedMemory: false, tier: 'T3' };
const LAYOUT = 'app/layout.tsx';
const PAGE = 'src/pages/address-list/ui/AddressListPage.tsx';

function web(): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'ay-hand-')), 'web');
  createWebRepo(dir);
  return dir;
}

/** Кодер не справляется с T1 (провайдер), с T2 (страница) — справляется. */
function runtime(seen: { t2: number }) {
  return new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], (req: ChatRequest): ChatMessage => {
    const system = req.messages[0]?.content ?? '';
    const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
    const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
    // другой подход тоже не находится — задача честно уходит человеку
    if (system.includes('планировщик') && /Прежний подход не сработал/.test(user)) return json({ understanding: '', tasks: [] });
    if (system.includes('планировщик')) {
      return json({
        understanding: 'Провайдер, потом страница.',
        tasks: [
          { id: 'T1', type: 'edit', title: 'Провайдер в layout', brief: 'Обернуть children в <main className="ay">', dependsOn: [], files: [LAYOUT], accept: { tests: [], commands: [] }, size: 'S' },
          { id: 'T2', type: 'edit', title: 'Заголовок страницы', brief: 'Адреса → Адреса доставки', dependsOn: ['T1'], files: [PAGE], accept: { tests: [], commands: [] }, size: 'S' },
        ],
      });
    }
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('кодер')) {
      const task = /## Задача\s+(\S+?):/.exec(user)?.[1];
      if (task === 'T2') {
        seen.t2 += 1;
        return json({ patches: [{ file: PAGE, search: '<h1>Адреса</h1>', replace: '<h1>Адреса доставки</h1>' }], note: 'ok' });
      }
      return json({ patches: [{ file: LAYOUT, search: 'такого фрагмента нет', replace: 'x' }], note: 'не вышло' });
    }
    return json({});
  });
}

const opts = (repo: string, rt: MockRuntime) => ({ repo, goal: 'оберни и переименуй', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, autoApply: true });

test('человек доделал задачу в своей копии — проверки, слияние, следующая задача сама, результат в проекте', async () => {
  const repo = web();
  const seen = { t2: 0 };
  const first = await new Pipeline({ ...opts(repo, runtime(seen)), runId: 'r1' }).run();
  assert.deepEqual(first.human.map((h) => h.id).sort(), ['T1', 'T2']);
  assert.match(first.human.find((h) => h.id === 'T2')!.why, /не начата/);
  assert.equal(seen.t2, 0);

  // «Открыть в редакторе»: своя рабочая копия от ветки прогона
  const h = await prepareHandoff(repo, 'r1', 'T1', [LAYOUT]);
  assert.ok(h.files[0]!.endsWith(path.join('app', 'layout.tsx')));
  // пустая сдача — не принимается, задача остаётся у человека
  const empty = await new Pipeline({ ...opts(repo, runtime(seen)), runId: 'r1', resume: true, humanFixes: ['T1'] }).run();
  assert.match(empty.human.find((x) => x.id === 'T1')!.why, /не изменены/);

  // человек правит и сохраняет
  const text = readFileSync(h.files[0]!, 'utf8');
  writeFileSync(h.files[0]!, text.replace('<body>{children}</body>', '<body><main className="ay">{children}</main></body>'));
  assert.deepEqual(await handoffChanges(h.dir), [LAYOUT]);

  const res = await new Pipeline({ ...opts(repo, runtime(seen)), runId: 'r1', resume: true, humanFixes: ['T1'] }).run();
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(res.human, [], journal);
  assert.deepEqual(res.done.sort(), ['T1', 'T2']);
  assert.equal(seen.t2, 1, 'T2 сделал агент после ручной правки');
  assert.match(journal, /T1: ручная правка человека принята/);
  assert.match(journal, /T2: блокер снят/);
  assert.ok(res.applied?.ok, journal);
  assert.match(readFileSync(path.join(repo, LAYOUT), 'utf8'), /<main className="ay">/);
  assert.match(readFileSync(path.join(repo, PAGE), 'utf8'), /Адреса доставки/);
  assert.ok(!existsSync(humanDir(repo, 'r1', 'T1')), 'ручная копия убрана');
});

test('ручная правка с ошибкой — задача остаётся у человека с причиной, агенты не трогаются', async () => {
  const repo = web();
  const seen = { t2: 0 };
  await new Pipeline({ ...opts(repo, runtime(seen)), runId: 'r2' }).run();
  const h = await prepareHandoff(repo, 'r2', 'T1', [LAYOUT, 'package.json']);
  writeFileSync(path.join(h.dir, 'package.json'), '{ "name": "web", сломано');
  const res = await new Pipeline({ ...opts(repo, runtime(seen)), runId: 'r2', resume: true, humanFixes: ['T1'] }).run();
  const why = res.human.find((x) => x.id === 'T1')!.why;
  assert.match(why, /не прошла проверку/);
  assert.equal(seen.t2, 0);
  assert.ok(existsSync(h.dir), 'копия с правкой человека сохранена — можно исправить и сохранить ещё раз');
});

test('правка человека в образце превращается в заплатки для однотипных файлов', () => {
  const diff = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -3,3 +3,3 @@', '   <div className="af-head">', '-    <h1>Адреса</h1>', '+    <h1>Адреса!</h1>', '   </div>'].join('\n');
  assert.deepEqual(patchesFromDiff('x', diff), [{ file: 'x', search: '  <div className="af-head">\n    <h1>Адреса</h1>\n  </div>', replace: '  <div className="af-head">\n    <h1>Адреса!</h1>\n  </div>' }]);
});

test('откат из истории: сразу после применения — как не было; после своих коммитов — обратным коммитом', async () => {
  const repo = web();
  const seen = { t2: 0 };
  const rt = new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], (req) => {
    const system = req.messages[0]?.content ?? '';
    const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
    if (system.includes('планировщик')) return json({ understanding: 'x', tasks: [{ id: 'T1', type: 'edit', title: 'Заголовок', brief: 'b', dependsOn: [], files: [PAGE], accept: { tests: [], commands: [] }, size: 'S' }] });
    if (system.includes('кодер')) {
      seen.t2 += 1;
      return json({ patches: [{ file: PAGE, search: '<h1>Адреса</h1>', replace: '<h1>Адреса доставки</h1>' }], note: 'ok' });
    }
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    return json({ verdict: 'approve', reasons: [] });
  });
  const res = await new Pipeline({ ...opts(repo, rt), runId: 'r3' }).run();
  assert.ok(res.applied?.ok);
  const back = await unapplyRun(repo, 'r3');
  assert.ok(back.ok, back.message);
  assert.match(readFileSync(path.join(repo, PAGE), 'utf8'), /<h1>Адреса<\/h1>/);

  // применили снова, потом свой коммит в другом файле
  assert.ok((await applyRun(repo, 'r3')).ok);
  writeFileSync(path.join(repo, 'README.md'), '# своё\n');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'своё'], { cwd: repo });
  const back2 = await unapplyRun(repo, 'r3');
  assert.ok(back2.ok, back2.message);
  assert.match(back2.message, /обратным коммитом/);
  assert.match(readFileSync(path.join(repo, PAGE), 'utf8'), /<h1>Адреса<\/h1>/);
  assert.equal(readFileSync(path.join(repo, 'README.md'), 'utf8'), '# своё\n');
  assert.equal(readMeta(repo, 'r3')?.applied, undefined);
});

test('сервер: «Открыть в редакторе» даёт копию и файлы, сохранение файла само запускает проверку и продолжение', async () => {
  const repo = web();
  const seen = { t2: 0 };
  await new Pipeline({ ...opts(repo, runtime(seen)), runId: 'r4' }).run();
  const srv = await startServer({ hardware: async () => HW, statsPath: null, runtimeFactory: () => runtime(seen) });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const post = async (p: string, body: unknown) => {
      const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'x-ay-token': srv.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, data: (await r.json()) as any };
    };
    const open = await post('/api/human/open', { repo, id: 'r4', taskId: 'T1' });
    assert.equal(open.status, 200, JSON.stringify(open.data));
    assert.equal(open.data.files.length, 1);
    // «Готово» без правок — понятный отказ
    const early = await post('/api/human/done', { repo, id: 'r4', taskId: 'T1' });
    assert.equal(early.status, 400);
    assert.match(early.data.error, /ничего не изменено/);
    // сохраняем файл — через пару секунд программа сама проверяет и продолжает прогон
    const f = open.data.files[0];
    writeFileSync(f, readFileSync(f, 'utf8').replace('<body>{children}</body>', '<body><main>{children}</main></body>'));
    const deadline = Date.now() + 20_000;
    let meta = readMeta(repo, 'r4');
    while (Date.now() < deadline && !(meta?.human.length === 0 && meta.applied)) {
      await new Promise((r) => setTimeout(r, 300));
      meta = readMeta(repo, 'r4');
    }
    assert.deepEqual(meta?.human, []);
    assert.ok(meta?.applied, 'результат применён в проект');
    assert.match(readFileSync(path.join(repo, PAGE), 'utf8'), /Адреса доставки/);
  } finally {
    await srv.close();
  }
});

test('«Разбить на подзадачи и попробовать без меня»: задача у человека → подзадачи → агенты доделывают цепочку сами', async () => {
  const repo = web();
  const seen = { t2: 0 };
  await new Pipeline({ ...opts(repo, runtime(seen)), runId: 'r5' }).run();
  // в продолжении планировщик на просьбу человека даёт две маленькие подзадачи, с которыми кодер справляется
  const rt = new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], (req: ChatRequest): ChatMessage => {
    const system = req.messages[0]?.content ?? '';
    const user = req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
    if (system.includes('планировщик') && /Человек попросил разбить/.test(user)) {
      return json({ understanding: 'по шагам', tasks: [
        { id: 'A', type: 'edit', title: 'Обёртка main', brief: 'main вокруг children', dependsOn: [], files: [LAYOUT], accept: { tests: [], commands: [] }, size: 'S' },
        { id: 'B', type: 'edit', title: 'Класс на main', brief: 'className ay', dependsOn: ['A'], files: [LAYOUT], accept: { tests: [], commands: [] }, size: 'S' },
      ] });
    }
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('кодер')) {
      const task = /## Задача\s+(\S+?):/.exec(user)?.[1];
      if (task === 'T1.1') return json({ patches: [{ file: LAYOUT, search: '<body>{children}</body>', replace: '<body><main>{children}</main></body>' }], note: 'ok' });
      if (task === 'T1.2') return json({ patches: [{ file: LAYOUT, search: '<main>{children}</main>', replace: '<main className="ay">{children}</main>' }], note: 'ok' });
      if (task === 'T2') return json({ patches: [{ file: PAGE, search: '<h1>Адреса</h1>', replace: '<h1>Адреса доставки</h1>' }], note: 'ok' });
    }
    return json({});
  });
  const res = await new Pipeline({ ...opts(repo, rt), runId: 'r5', resume: true, retryTasks: ['T1'] }).run();
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(res.human, [], journal);
  assert.match(journal, /человек попросил разбить задачу/);
  assert.ok(res.done.includes('T1.1') && res.done.includes('T1.2') && res.done.includes('T2'), res.done.join(','));
  assert.ok(res.applied?.ok, journal);
  assert.match(readFileSync(path.join(repo, LAYOUT), 'utf8'), /<main className="ay">/);
  assert.match(readFileSync(path.join(repo, PAGE), 'utf8'), /Адреса доставки/);
});
