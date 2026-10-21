// «Стоп» обрывает запрос к модели сразу; критерий не падает на старых ошибках проекта; справка из интернета по делу.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bingTarget, errorQuery, libraryOfError, packagesOfHelp, parseBing, relevantHits } from '../src/lookup.ts';
import { isRedundantCheck, validatePlan } from '../src/plan.ts';
import { repairJson } from '../src/runtime/ollama.ts';
import { createWebRepo } from '../src/demo.ts';
import { MockRuntime } from '../src/runtime/mock.ts';
import { Pipeline } from '../src/pipeline.ts';
import { loadCatalog } from '../src/catalog.ts';
import { Stats } from '../src/stats.ts';
import type { ChatMessage, ChatRequest, ChatResponse } from '../src/runtime/types.ts';
import type { Hardware } from '../src/types.ts';

const HW: Hardware = { gpuName: 'test', vramTotalGb: 16, vramFreeGb: 16, ramTotalGb: 32, ramFreeGb: 24, cpuCores: 8, unifiedMemory: false, tier: 'T2' };
const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
const PAGE = 'src/pages/address-list/ui/AddressListPage.tsx';

function web(): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'ay-stop-')), 'web');
  createWebRepo(dir);
  return dir;
}

/** Модель «думает» бесконечно, пока запрос не оборвут. */
class HangingRuntime extends MockRuntime {
  started = 0;
  aborted = 0;
  override async chat(req: ChatRequest): Promise<ChatResponse> {
    const system = req.messages[0]?.content ?? '';
    if (/планировщик|приёмщик|ревьюер/.test(system)) return super.chat(req);
    this.started += 1;
    return new Promise<ChatResponse>((_, reject) => {
      req.signal?.addEventListener('abort', () => {
        this.aborted += 1;
        reject(new Error('aborted'));
      });
    });
  }
}

test('«Стоп»: запрос к модели обрывается сразу, попытка не засчитана, задача уходит человеку с честной причиной', async () => {
  const repo = web();
  const tasks = [{ id: 'T1', type: 'edit', title: 'Заголовок', brief: 'Поменять заголовок', dependsOn: [], files: [PAGE], accept: { tests: [], commands: [] }, size: 'S' }];
  const rt = new HangingRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], (req) => {
    const system = req.messages[0]?.content ?? '';
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    return json({ understanding: 'x', tasks });
  });
  const phases: string[] = [];
  const p = new Pipeline({ repo, goal: 'заголовок', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, onEvent: (e) => e.kind === 'phase' && phases.push(e.phase) });
  const res = p.run();
  for (let i = 0; i < 200 && rt.started === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(rt.started, 1, 'исполнитель начал работу');
  const t0 = Date.now();
  p.stop();
  const r = await res;
  assert.ok(Date.now() - t0 < 5000, 'прогон закончился сразу после «Стопа»');
  assert.equal(rt.aborted, 1, 'запрос к модели оборван');
  assert.deepEqual(r.human.map((h) => h.id), ['T1']);
  assert.match(r.human[0]!.why, /прогон остановлен человеком/);
  const journal = readFileSync(path.join(r.runDir, 'journal.txt'), 'utf8');
  assert.match(journal, /Человек нажал «Стоп» — запрос к модели по T1 оборван/);
  assert.match(journal, /попытка не засчитана/);
  assert.doesNotMatch(journal, /исчерпан бюджет|ступень/);
  const state = JSON.parse(readFileSync(path.join(r.runDir, 'state.json'), 'utf8'));
  assert.equal(state.tasks.find((t: { id: string }) => t.id === 'T1').attempts, 0);
  assert.ok(phases.includes('stopping'), phases.join(','));
});

test('ответ gpt-oss, который Ollama не разобрала как «вызов инструмента», чинится: закрываются скобки', () => {
  assert.equal(repairJson('{"patches":[{"file":"a.tsx","search":"x","replace":"y"}]'), '{"patches":[{"file":"a.tsx","search":"x","replace":"y"}]}');
  assert.equal(repairJson('{"note":"обрыв'), '{"note":"обрыв"}');
  assert.equal(repairJson('{"a":1,'), '{"a":1}');
  assert.equal(repairJson('просто текст'), null);
});

test('дубли проверки типов в критерии убираются: она идёт отдельной ступенью с учётом старых ошибок', () => {
  const commands = { typecheck: 'npx --no-install tsc --noEmit', lint: null, test: null } as never;
  assert.equal(isRedundantCheck('npx --no-install tsc --noEmit', commands), true);
  assert.equal(isRedundantCheck('npx tsc --noEmit -p .', commands), true);
  assert.equal(isRedundantCheck('npm run lint', commands), true);
  assert.equal(isRedundantCheck('npm run build', commands), false);
  const repo = web();
  const check = validatePlan({ goal: 'x', tasks: [{ id: 'T1', type: 'edit', title: 'Кнопки', brief: 'кнопки', dependsOn: [], files: [PAGE], accept: { tests: [], commands: ['npx --no-install tsc --noEmit'] }, size: 'S' }] } as never, repo, 'T2', commands);
  assert.ok(check.ok);
  assert.deepEqual(check.plan.tasks[0]!.accept.commands, []);
});

test('критерий не падает на ошибках, которые были в проекте до прогона', async () => {
  const repo = web();
  const OLD = 'src/features/audit-log-form/ui/AuditLogForm.tsx(32,82): error TS2322: Type \'Resolver<X>\' is not assignable to type \'Resolver<Y>\'.';
  writeFileSync(path.join(repo, 'old.mjs'), `console.log(${JSON.stringify(OLD)}); process.exit(1);\n`);
  const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
  pkg.scripts.typecheck = 'node old.mjs';
  pkg.scripts.build = 'node old.mjs';
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify(pkg, null, 2));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'old errors'], { cwd: repo });
  const tasks = [{ id: 'T1', type: 'edit', title: 'Проверить, что заголовок на месте', brief: 'Убедись, что заголовок есть', dependsOn: [], files: [PAGE], accept: { tests: [], commands: ['npm run build'] }, size: 'S' }];
  let coderCalls = 0;
  const rt = new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], (req) => {
    const system = req.messages[0]?.content ?? '';
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('планировщик')) return json({ understanding: 'x', tasks });
    coderCalls += 1;
    return json({ patches: [], note: 'нечего' });
  });
  const r = await new Pipeline({ repo, goal: 'проверить', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true }).run();
  const journal = readFileSync(path.join(r.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(r.done, ['T1'], journal);
  assert.equal(coderCalls, 0, 'модель не понадобилась — программа сама увидела, что всё на месте');
});

test('справка из интернета: ссылки Bing раскрываются, мусор отсекается, наши проверки не ищутся, библиотека — по строке с ошибкой', () => {
  const real = 'https://stackoverflow.com/questions/52423842/never-error';
  const enc = Buffer.from(real).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const wrapped = `https://www.bing.com/ck/a?!&amp;&amp;p=937bb1&amp;ptn=3&amp;ver=2&amp;u=a1${enc}&amp;ntb=1`;
  assert.equal(bingTarget(wrapped), real);
  const bing = `<li class="b_algo"><h2><a href="${wrapped}">TS2345 never</a></h2><p>Argument of type string is not assignable to never</p></li>`;
  assert.equal(parseBing(bing)[0]!.url, real);

  const q = 'error TS2345: Argument of type \'string\' is not assignable to parameter of type \'never\'. react-hook-form 7';
  const hits = relevantHits(
    [
      { title: 'What is "not assignable to parameter of type never" error in TypeScript?', url: real, snippet: '' },
      { title: 'Анализ психологической готовности ребёнка', url: 'https://infourok.ru/x.html', snippet: 'диагностика' },
      { title: 'react-hook-form setValue typing', url: 'https://github.com/react-hook-form/react-hook-form/issues/1', snippet: 'TS2345 when values are Record<string, unknown>' },
    ],
    q,
  );
  assert.deepEqual(hits.map((h) => h.url), [real, 'https://github.com/react-hook-form/react-hook-form/issues/1']);

  assert.equal(errorQuery('Ступень 2 (признаки готовности):\nв src/a.tsx нет «Button»'), '');
  const form = "import { useForm } from 'react-hook-form';\nimport { Button } from '@mantine/core';\nexport function F() {\n  const form = useForm<Record<string, unknown>>();\n  form.setValue('name', 'x');\n}\n";
  const err = "src/features/f/ui/F.tsx(5,18): error TS2345: Argument of type 'string' is not assignable to parameter of type 'never'.";
  assert.equal(libraryOfError(form, err), 'react-hook-form');
  assert.match(errorQuery(err, { 'react-hook-form': '^7.54.0' }, ['react-hook-form']), /never'\. react-hook-form 7$/);
  assert.deepEqual(packagesOfHelp('// node_modules/react-hook-form/dist/types/resolvers.d.ts\nexport type Resolver = …'), ['react-hook-form']);
});
