// Большой сгенерированный фронтенд без тестов (как web/ пользователя от 19.10):
// подпапка вместо корня, нет node_modules, нет тестов, карта проекта не влезает.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildRepoMap, renderRepoMap, groupByTemplate } from '../src/repomap.ts';
import { checkReadiness } from '../src/readiness.ts';
import { adaptToProject, validatePlan } from '../src/plan.ts';
import { MockRuntime } from '../src/runtime/mock.ts';
import { Pipeline } from '../src/pipeline.ts';
import { loadCatalog } from '../src/catalog.ts';
import { Stats } from '../src/stats.ts';
import type { ChatMessage, ChatRequest } from '../src/runtime/types.ts';
import type { Hardware, Plan } from '../src/types.ts';

const HW: Hardware = { gpuName: 'test', vramTotalGb: 48, vramFreeGb: 48, ramTotalGb: 64, ramFreeGb: 32, cpuCores: 8, unifiedMemory: false, tier: 'T3' };
const ENTITIES = ['address', 'audit-log', 'category', 'file', 'notification', 'order', 'order-item', 'payment', 'product', 'product-image', 'refund', 'review', 'role', 'session', 'user', 'tag'];
const pascal = (s: string) => s.split('-').map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');

function makeWeb(): string {
  const root = path.join(mkdtempSync(path.join(tmpdir(), 'ay-web-')), 'web');
  const w = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  w('package.json', JSON.stringify({ name: 'web', private: true, scripts: { dev: 'next dev' }, dependencies: { next: '^15', react: '^19' }, devDependencies: { typescript: '^5' } }));
  w('tsconfig.json', '{"compilerOptions":{"strict":true,"jsx":"preserve"}}');
  w('src/shared/ui/generated.css', '.af-page { max-width: 1100px; }\n.af-btn { padding: 7px 14px; }\n');
  w('app/layout.tsx', 'export default function RootLayout({ children }: { children: any }) { return children }\n');
  for (const e of ENTITIES) {
    const P = pascal(e);
    w(`app/(generated)/${e}s/page.tsx`, `export { ${P}ListPage as default } from '../../../src/pages/${e}-list'\n`);
    w(`app/(generated)/${e}s/[id]/page.tsx`, `export { ${P}ViewPage as default } from '../../../../src/pages/${e}-view'\n`);
    w(`src/entities/${e}/api/${e}-api.ts`, `export function get${P}(id: string) { return fetch('/api/${e}/' + id) }\n`);
    w(`src/entities/${e}/model/types.ts`, `export type ${P} = { id: string }\n`);
    for (const kind of ['list', 'view', 'edit']) {
      w(`src/pages/${e}-${kind}/ui/${P}${pascal(kind)}Page.tsx`, `import '../../../shared/ui/generated.css'\nexport function ${P}${pascal(kind)}Page() { return <div className="af-page" /> }\n`);
      w(`src/pages/${e}-${kind}/index.ts`, `export * from './ui/${P}${pascal(kind)}Page'\n`);
    }
  }
  return root;
}

test('карта большого проекта: одинаковые файлы свёрнуты в шаблоны, общий CSS виден', () => {
  const root = makeWeb();
  const map = buildRepoMap(root);
  assert.ok(map.files.length > 150);
  const text = renderRepoMap(map);
  assert.ok(text.length <= 6000, `карта ${text.length} символов`);
  assert.doesNotMatch(text, /обрезан/);
  assert.match(text, /src\/pages\/\*\/ui\/\*Page\.tsx — 48 шт\./);
  assert.match(text, /src\/entities\/\*\/api\/\*-api\.ts — 16 шт\./);
  assert.match(text, /src\/shared\/ui\/generated\.css/);
  const { rest } = groupByTemplate(map.files);
  assert.ok(rest.length < 10);
});

test('готовность: подпапка — предупреждение с подсказкой корня (для документов годится и она); нет node_modules и тестов — предупреждения', () => {
  const root = makeWeb();
  const sub = checkReadiness(path.join(root, 'app', '(generated)'), false);
  const warn = sub.find((r) => r.code === 'not-root');
  assert.equal(warn?.level, 'warn');
  assert.equal(warn?.suggest, root);
  assert.ok(!sub.some((r) => r.level === 'block'));
  const top = checkReadiness(root, true);
  const codes = top.map((r) => r.code);
  assert.ok(codes.includes('no-deps'));
  assert.ok(codes.includes('no-tests'));
  assert.ok(codes.includes('no-types'));
  assert.ok(!top.some((r) => r.level === 'block'));
  // npx без установленного typescript не используем
  assert.equal(buildRepoMap(root).commands.typecheck, null);
});

test('план без тестов в проекте: задачи-тесты убраны, критерий — проверка типов или честное «нечем»', () => {
  const plan = {
    goal: 'g',
    tasks: [
      { id: 'T1', type: 'edit', title: 'Кнопка', brief: 'b', dependsOn: [], files: ['src/shared/ui/Button.tsx'], newFiles: ['src/shared/ui/Button.tsx'], accept: { tests: ['src/shared/ui/Button.test.tsx'], commands: [] }, size: 'S', testFirst: true },
    ],
  } as unknown as Plan;
  const withTypes = adaptToProject(validatePlan(plan, '/nonexistent', 'T2').plan, { test: null, testFiles: null, lint: null, typecheck: 'npx --no-install tsc --noEmit' });
  assert.deepEqual(withTypes.tasks.map((t) => t.id), ['T1']);
  // проверка типов идёт ступенью каскада, отдельной командой не дублируется
  assert.deepEqual(withTypes.tasks[0]!.accept, { tests: [], commands: [] });
  assert.match(withTypes.tasks[0]!.brief, /Тестов не писать/);
  assert.deepEqual(withTypes.tasks[0]!.dependsOn, []);

  const root = makeWeb();
  const r = validatePlan(plan, root, 'T2', { test: null, testFiles: null, lint: null, typecheck: null });
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.ok(r.warnings.some((w) => /проверить программой нечем/.test(w)));
});

test('прогон на проекте без тестов: тест-задачи не появляются, журнал честно говорит, чем проверено', async () => {
  const root = makeWeb();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: root });
  const NEW_CSS = '.af-page { max-width: 1200px; padding: 24px; }\n.af-btn { padding: 8px 16px; border-radius: 8px; }\n';
  const script = (req: ChatRequest): ChatMessage => {
    const system = req.messages[0]?.content ?? '';
    const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
    if (system.includes('планировщик')) {
      return json({ tasks: [{ id: 'T1', type: 'edit', title: 'Новый вид', brief: 'Перепиши generated.css', dependsOn: [], files: ['src/shared/ui/generated.css'], accept: { tests: ['src/shared/ui/generated.test.ts'], commands: [] }, size: 'S', testFirst: true }] });
    }
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('кодер')) {
      return json({ patches: [{ file: 'src/shared/ui/generated.css', search: '.af-page { max-width: 1100px; }\n.af-btn { padding: 7px 14px; }', replace: NEW_CSS.trim() }], note: 'стили' });
    }
    if (system.includes('тестировщик')) throw new Error('тестировщика звать нельзя: тестов в проекте нет');
    return json({});
  };
  const rt = new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], script);
  const res = await new Pipeline({ repo: root, goal: 'Сделай страницы красивее', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true }).run();
  assert.deepEqual(res.done, ['T1']);
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.match(journal, /в проекте нет тестов/);
  assert.match(journal, /убрал задачи-тесты|проверить программой нечем/);
  const css = execFileSync('git', ['show', `${res.branch}:src/shared/ui/generated.css`], { cwd: root, encoding: 'utf8' });
  assert.match(css, /border-radius: 8px/);
});

test('повтор прогона 19.10 15:18: старые ошибки проверки не валят задачу, CSS переписывается целиком, лишний файл отклоняется', async () => {
  const root = path.join(mkdtempSync(path.join(tmpdir(), 'ay-css-')), 'web');
  const w = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  w('package.json', JSON.stringify({ name: 'web', private: true, type: 'module', scripts: { lint: 'node lint.mjs' } }));
  // «линтер»: одна старая ошибка есть всегда, новая — если в CSS опечатка 12x
  w('lint.mjs', `import { readFileSync } from 'node:fs';
const errs = ['src/features/audit-log-form/ui/AuditLogForm.tsx(16,5): error TS2322: Type Resolver is not assignable'];
if (readFileSync('src/shared/ui/generated.css', 'utf8').includes('12x')) errs.push('src/shared/ui/generated.css(3,1): error CSS1: bad unit 12x');
console.log(errs.join('\\n')); process.exit(1);
`);
  w('src/shared/ui/generated.css', '.af-page { max-width: 1100px; }\n.af-btn { padding: 7px 14px; }\n.af-error { font-size: 12px; }\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: root });

  const NEW_CSS = Array.from({ length: 120 }, (_, i) => `.af-x${i} { padding: ${i}px; }`).join('\n');
  let coderCalls = 0;
  const script = (req: ChatRequest): ChatMessage => {
    const system = req.messages[0]?.content ?? '';
    const last = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
    if (system.includes('планировщик')) {
      return json({ tasks: [{ id: 'T1', type: 'edit', title: 'Rewrite generated.css and add test', brief: 'Перепиши CSS и добавь тест', dependsOn: [], files: ['src/shared/ui/generated.css'], accept: { tests: [], commands: [] }, size: 'S' }] });
    }
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('кодер')) {
      coderCalls += 1;
      if (coderCalls === 1) {
        return json({ patches: [{ file: 'src/shared/ui/generated.css', search: '', replace: NEW_CSS + '\n.af-error { font-size: 12x; }' }, { file: 'accept.tests/generated-css.test.ts', search: '', replace: 'test' }], note: 'css + тест' });
      }
      if (/Менять можно только файлы задачи/.test(last)) {
        return json({ patches: [{ file: 'src/shared/ui/generated.css', search: '', replace: NEW_CSS + '\n.af-error { font-size: 12x; }' }], note: 'css' });
      }
      return json({ patches: [{ file: 'src/shared/ui/generated.css', search: '', replace: NEW_CSS + '\n.af-error { font-size: 12px; }' }], note: 'css без опечатки' });
    }
    return json({});
  };
  const rt = new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], script);
  const res = await new Pipeline({ repo: root, goal: 'Перепиши src/shared/ui/generated.css', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true }).run();
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(res.done, ['T1'], journal);
  assert.match(journal, /находит 1 ошибок ещё до начала работы/);
  assert.match(journal, /провал на ступени 4 \(линтер\)/);
  assert.doesNotMatch(journal, /Изменено \d+ строк при лимите/);
  const css = execFileSync('git', ['show', `${res.branch}:src/shared/ui/generated.css`], { cwd: root, encoding: 'utf8' });
  assert.doesNotMatch(css, /max-width: 1100px/, 'старые правила должны уйти — файл переписан целиком');
  assert.match(css, /font-size: 12px/);
  assert.throws(() => execFileSync('git', ['show', `${res.branch}:accept.tests/generated-css.test.ts`], { cwd: root, stdio: 'pipe' }));
});

test('повтор сбоя 19.10 16:09: Ollama не загрузила ревьюера — прогон не падает, ревьюит оставшаяся модель', async () => {
  const root = makeWeb();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: root });
  const script = (req: ChatRequest): ChatMessage => {
    const system = req.messages[0]?.content ?? '';
    const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
    if (system.includes('планировщик')) return json({ tasks: [{ id: 'T1', type: 'edit', title: 'Цвет', brief: 'Константа цвета', dependsOn: [], files: ['src/color.ts'], newFiles: ['src/color.ts'], accept: { tests: [], commands: [] }, size: 'M' }] });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('кодер')) return json({ patches: [{ file: 'src/color.ts', search: '', replace: "export const COLOR = 'red'\n" }], note: 'цвет' });
    return json({});
  };
  class CrashyRuntime extends MockRuntime {
    loads: string[] = [];
    async load(tag: string): Promise<number> {
      this.loads.push(tag);
      // ревьюер qwen не грузится ни разу (теперь лишних смен нет — до него доходит только тот, кому он правда нужен)
      if (tag === 'qwen3.6:latest') {
        throw new Error('Ollama /api/generate: 500 {"error":"llama-server process has terminated: exit status 0xc0000409: CUDA error: shared object initialization failed"}');
      }
      return super.load(tag);
    }
  }
  const rt = new CrashyRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], script);
  const p = new Pipeline({ repo: root, goal: 'Перепиши CSS', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true });
  p.loadRetries = [5, 5];
  const res = await p.run();
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(res.done, ['T1'], journal);
  assert.match(journal, /не загрузилась \(попытка 1\)/);
  assert.match(journal, /не загрузилась ни на видеокарту, ни на процессор — дальше работаю без неё/);
  // ревьюера не загрузить — ревьюит оставшаяся модель, приёмку тоже делает она
  assert.match(journal, /Ревьюер \(gpt-oss:20b\) принял T1/);
  assert.match(journal, /Приёмка по цели[^\n]*gpt-oss:20b/);
});

test('видеокарта перестала загружать любые модели (CUDA) — прогон доходит до конца на процессоре', async () => {
  const root = makeWeb();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: root });
  const script = (req: ChatRequest): ChatMessage => {
    const system = req.messages[0]?.content ?? '';
    const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
    if (system.includes('планировщик')) return json({ tasks: [{ id: 'T1', type: 'edit', title: 'Цвет', brief: 'Константа цвета', dependsOn: [], files: ['src/color.ts'], newFiles: ['src/color.ts'], accept: { tests: [], commands: [] }, size: 'M' }] });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('кодер')) return json({ patches: [{ file: 'src/shared/ui/generated.css', search: '', replace: '.af-page { color: red; }\n' }], note: 'css' });
    return json({});
  };
  class DeadGpu extends MockRuntime {
    loadCalls: { tag: string; cpu: boolean }[] = [];
    async load(tag: string, numCtx?: number, opts?: { cpuOnly?: boolean }): Promise<number> {
      this.loadCalls.push({ tag, cpu: !!opts?.cpuOnly });
      if (!opts?.cpuOnly) throw new Error('Ollama /api/generate: 500 {"error":"llama-server process has terminated: exit status 0xc0000409: CUDA error: shared object initialization failed"}');
      return super.load(tag);
    }
  }
  const rt = new DeadGpu([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], script);
  const p = new Pipeline({ repo: root, goal: 'Перепиши CSS', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true });
  p.loadRetries = [5, 5];
  const res = await p.run();
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(res.done, ['T1'], journal);
  assert.match(journal, /работают на процессоре/);
  // после первого отказа видеокарты следующие модели сразу грузятся на процессор, без трёх лишних попыток
  const gpuTries = rt.loadCalls.filter((c) => !c.cpu).length;
  assert.equal(gpuTries, 3, JSON.stringify(rt.loadCalls));
});

test('повтор прогона 19.10 16:25: старая ошибка tsc с переставленными полями типа — не новая; кэш tsc не попадает в коммит', async () => {
  const { errorLineKey, newErrors, countErrorKeys } = await import('../src/checks.ts');
  const before = `src/features/audit-log-form/ui/AuditLogForm.tsx(16,5): error TS2322: Type 'Resolver<{ table_name: string; record_id: string; action: "insert" | "update" | "delete"; }>' is not assignable`;
  const after = `src/features/audit-log-form/ui/AuditLogForm.tsx(16,5): error TS2322: Type 'Resolver<{ action: "insert" | "update" | "delete"; table_name: string; record_id: string; }>' is not assignable`;
  assert.equal(errorLineKey(before), errorLineKey(after));
  const known = countErrorKeys([before]);
  assert.deepEqual(newErrors([after], known), []);
  const extra = `src/features/audit-log-form/ui/AuditLogForm.tsx(40,1): error TS2322: Type 'x' is not assignable`;
  assert.deepEqual(newErrors([after, extra], known), [extra], 'вторая такая же ошибка в том же файле — новая');
  assert.equal(newErrors([`src\\entities\\a.ts(1,37): error TS2306: File 'C:/x/http.ts' is not a module.`], known).length, 1);

  const { Workspace } = await import('../src/git.ts');
  const root = makeWeb();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: root });
  const ws = new Workspace(root, 'r1');
  await ws.init();
  const { dir } = await ws.createTaskWorktree('T1');
  writeFileSync(path.join(dir, 'tsconfig.tsbuildinfo'), '{"huge":true}');
  mkdirSync(path.join(dir, '.next'), { recursive: true });
  writeFileSync(path.join(dir, '.next', 'build.js'), 'x');
  writeFileSync(path.join(dir, 'src/shared/ui/generated.css'), '.af-page { color: red; }\n');
  await ws.commitAll(dir, 'T1: css');
  const diff = await ws.diffAgainstIntegration(dir);
  assert.match(diff, /generated\.css/);
  assert.doesNotMatch(diff, /tsbuildinfo|\.next/);
});

test('видеокарта сбоит дважды — Ollama перезапускается, модель встаёт на видеокарту; дальше смены моделей сведены к минимуму', async () => {
  const root = makeWeb();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: root });
  const script = (req: ChatRequest): ChatMessage => {
    const system = req.messages[0]?.content ?? '';
    const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
    if (system.includes('планировщик')) return json({ understanding: 'x', tasks: [{ id: 'T1', type: 'edit', title: 'CSS', brief: 'b', dependsOn: [], files: ['src/shared/ui/generated.css'], accept: { tests: [], commands: [] }, size: 'S' }] });
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    return json({ patches: [{ file: 'src/shared/ui/generated.css', search: '.af-btn {', replace: '.af-btn { outline: none;' }], note: 'ok' });
  };
  class Restartable extends MockRuntime {
    restarted = 0;
    broken = true;
    loadCalls: string[] = [];
    async load(tag: string, numCtx?: number, opts?: { cpuOnly?: boolean }): Promise<number> {
      this.loadCalls.push(`${tag}${opts?.cpuOnly ? ':cpu' : ''}`);
      if (this.broken && !opts?.cpuOnly) throw new Error('Ollama /api/generate: 500 {"error":"llama-server process has terminated: exit status 0xc0000409: CUDA error: shared object initialization failed"}');
      return super.load(tag);
    }
    async restart(): Promise<boolean> {
      this.restarted += 1;
      this.broken = false;
      return true;
    }
  }
  const rt = new Restartable([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], script);
  const p = new Pipeline({ repo: root, goal: 'Перепиши CSS', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true });
  p.loadRetries = [5, 5];
  const res = await p.run();
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(res.done, ['T1'], journal);
  assert.equal(rt.restarted, 1);
  assert.match(journal, /перезапустил Ollama/);
  assert.match(journal, /держусь одной загруженной модели/);
  assert.ok(!rt.loadCalls.some((c) => c.endsWith(':cpu')), `после перезапуска процессор не понадобился: ${rt.loadCalls.join(', ')}`);
});

test('диспетчер на нестабильной видеокарте держится загруженной модели, даже для ревью', async () => {
  const { chooseNext } = await import('../src/dispatcher.ts');
  const catalog = loadCatalog();
  const qwen = catalog.find((m) => m.ollamaTag.startsWith('qwen3.6'))!;
  const oss = catalog.find((m) => m.ollamaTag.startsWith('gpt-oss'))!;
  const stats = new Stats(null);
  const task = { id: 'T1', type: 'edit', role: 'coder', title: '', brief: '', dependsOn: [], files: [], accept: { tests: [], commands: [] }, size: 'S', status: 'review', weight: 1, attempts: 0, ladderStep: 0, failures: [], readySince: Date.now(), frozenFiles: [], doneBy: qwen.id } as any;
  const ctx = (shaky: boolean) => ({ team: { models: [qwen, oss] } as any, stats, loadedModelId: qwen.id, now: Date.now(), fits: () => true, shaky });
  assert.equal(chooseNext([{ task, role: 'reviewer', kind: 'review' }], ctx(false))!.model.id, oss.id, 'обычно ревьюит другая модель');
  assert.equal(chooseNext([{ task, role: 'reviewer', kind: 'review' }], ctx(true))!.model.id, qwen.id, 'на сбоящей видеокарте — та же, без смены');
});
