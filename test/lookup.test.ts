// Справка по ошибке: типы установленных библиотек (без сети), поиск в интернете, задачи «менять нечего».

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { declarationIn, errorQuery, excerpt, localTypeHelp, parseBing, parseDuckDuckGo, propsFromError, typeNamesFromError } from '../src/lookup.ts';
import { isCheckCommand } from '../src/plan.ts';
import { createWebRepo } from '../src/demo.ts';
import { MockRuntime } from '../src/runtime/mock.ts';
import { Pipeline } from '../src/pipeline.ts';
import { loadCatalog } from '../src/catalog.ts';
import { Stats } from '../src/stats.ts';
import type { ChatMessage, ChatRequest } from '../src/runtime/types.ts';
import type { Hardware } from '../src/types.ts';

const TS2322 = "app/layout.tsx(12,59): error TS2322: Type '{ children: ReactNode; theme: { primaryColor: string; }; colorScheme: string; }' is not assignable to type 'IntrinsicAttributes & MantineProviderProps'.\n  Property 'colorScheme' does not exist on type 'IntrinsicAttributes & MantineProviderProps'.";
const DTS = `import type { ReactNode } from 'react';
export interface MantineProviderProps {
    /** Theme override object */
    theme?: MantineThemeOverride;
    /** Color scheme used by default */
    defaultColorScheme?: MantineColorScheme;
    /** Forced color scheme */
    forceColorScheme?: 'light' | 'dark';
    children?: ReactNode;
}
export declare function MantineProvider(props: MantineProviderProps): JSX.Element;
`;

test('справка: из ошибки — имена типов и свойств; объявление находится в node_modules', () => {
  assert.deepEqual(typeNamesFromError(TS2322), ['MantineProviderProps']);
  assert.deepEqual(propsFromError(TS2322), ['colorScheme']);
  assert.deepEqual(typeNamesFromError("error TS2353: 'colorScheme' does not exist in type 'PartialObjectDeep<MantineTheme, { recurseIntoArrays: false; }>'"), ['MantineTheme']);
  assert.match(declarationIn(DTS, 'MantineProviderProps')!, /defaultColorScheme\?: MantineColorScheme;[\s\S]*\}$/);
  const root = mkdtempSync(path.join(tmpdir(), 'ay-lk-'));
  mkdirSync(path.join(root, 'node_modules/@mantine/core/lib/core/MantineProvider'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules/@mantine/core/lib/core/MantineProvider/MantineProvider.d.ts'), DTS);
  const help = localTypeHelp(root, "import { MantineProvider } from '@mantine/core'\n", TS2322)!;
  assert.match(help, /node_modules\/@mantine\/core\/lib\/core\/MantineProvider\/MantineProvider\.d\.ts/);
  assert.match(help, /defaultColorScheme/);
});

test('справка: запрос без путей проекта, с библиотекой и версией; разбор выдачи поисковиков и выдержки', () => {
  const q = errorQuery(`Новые ошибки (бывшие до прогона не считаются: 2):\n${TS2322}`, { '@mantine/core': '^9.7.3', react: '^19' });
  assert.doesNotMatch(q, /app\/layout\.tsx/);
  assert.match(q, /^error TS2322/);
  assert.match(q, /@mantine\/core 9$/);
  const ddg = '<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fmantine.dev%2Ftheming%2Fcolor-schemes%2F&amp;rut=x">Color schemes | <b>Mantine</b></a><a class="result__snippet" href="#">Use <b>defaultColorScheme</b> prop</a></div>';
  assert.deepEqual(parseDuckDuckGo(ddg), [{ title: 'Color schemes | Mantine', url: 'https://mantine.dev/theming/color-schemes/', snippet: 'Use defaultColorScheme prop' }]);
  const bing = '<li class="b_algo"><h2><a href="https://github.com/mantinedev/mantine/issues/1">colorScheme removed</a></h2><div><p>In v7 use defaultColorScheme</p></div></li>';
  assert.equal(parseBing(bing)[0]!.url, 'https://github.com/mantinedev/mantine/issues/1');
  const ex = excerpt('<html><script>x</script><p>Intro</p><p>MantineProvider no longer supports colorScheme prop, use defaultColorScheme="dark" instead.</p></html>', ['colorScheme']);
  assert.match(ex, /use defaultColorScheme="dark" instead/);
});

test('критерий: grep, test, findstr — не проверки (в Windows их нет, «на отсутствие» падают всегда)', () => {
  assert.equal(isCheckCommand('grep -q "className=\\"af-table\\" className=\\"af-table\\"" src/pages/*/ui/*ListPage.tsx || exit 1'), false);
  assert.equal(isCheckCommand('npm run test'), true);
  assert.equal(isCheckCommand('npx tsc --noEmit'), true);
  assert.equal(isCheckCommand('npm run lint && grep x y'), false);
});

const HW: Hardware = { gpuName: 'test', vramTotalGb: 16, vramFreeGb: 16, ramTotalGb: 32, ramFreeGb: 24, cpuCores: 8, unifiedMemory: false, tier: 'T2' };
const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
const PAGE = 'src/pages/address-list/ui/AddressListPage.tsx';

function web(): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'ay-lk2-')), 'web');
  createWebRepo(dir);
  return dir;
}

function run(repo: string, tasks: unknown[], coder: (task: string, user: string) => ChatMessage, extra: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const rt = new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], (req: ChatRequest) => {
    const system = req.messages[0]?.content ?? '';
    const user = req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('планировщик')) return json({ understanding: 'x', tasks });
    const task = /## Задача\s+(\S+?):/.exec(user)?.[1] ?? '';
    calls.push(`${system.includes('аналитик') ? 'analyst' : 'coder'}:${task}`);
    return coder(task, user);
  });
  return { calls, res: new Pipeline({ repo, goal: 'таблицы', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, autoApply: true, ...extra }).run() };
}

test('задача «проверить / убедиться»: сначала проверяет программа, модель не нужна; «grep» из критерия убран', async () => {
  const repo = web();
  const { calls, res } = run(repo, [{ id: 'T1', type: 'edit', title: 'Проверить отсутствие дублирующих className у таблиц', brief: 'Убедись, что нет повторов', dependsOn: [], files: [], accept: { tests: [], commands: ['grep -q "className=\\"af-table\\" className=\\"af-table\\"" src/pages/*/ui/*ListPage.tsx || exit 1'] }, size: 'S' }], () => json({ patches: [], note: 'нечего' }));
  const r = await res;
  const journal = readFileSync(path.join(r.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(r.done, ['T1'], journal);
  assert.deepEqual(calls, []);
  assert.match(journal, /T1: закрыта без правки — проверочная задача: на текущем коде всё уже так/);
});

test('исполнитель дважды «менять нечего» — программа проверяет и закрывает, а не гонит лестницу до человека', async () => {
  const repo = web();
  const { calls, res } = run(repo, [{ id: 'T1', type: 'edit', title: 'Убрать дублирующий className у Table', brief: 'Если есть дубли — убрать', dependsOn: [], files: [PAGE], accept: { tests: [], commands: [] }, size: 'S' }], () =>
    json({ patches: [{ file: PAGE, search: '<h1>', replace: '<h1>' }], note: 'дублей нет' }),
  );
  const r = await res;
  const journal = readFileSync(path.join(r.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(r.done, ['T1'], journal);
  assert.ok(calls.length <= 4, calls.join(' '));
  assert.doesNotMatch(journal, /ступень 3|ждёт человека/);
  assert.match(journal, /исполнитель дважды ответил, что менять нечего/);
});

test('ошибка проверок повторяется — справка из типов библиотеки уходит исполнителю', async () => {
  const repo = web();
  // проверка типов проекта: требует строку «defaultColorScheme» в layout, иначе ошибка как у Mantine
  writeFileSync(path.join(repo, 'typecheck.mjs'), `import { readFileSync } from 'node:fs';\nconst t = readFileSync('app/layout.tsx', 'utf8');\nif (t.includes('colorScheme=')) { console.log(${JSON.stringify(TS2322)}); process.exit(1); }\n`);
  mkdirSync(path.join(repo, 'node_modules/@mantine/core'), { recursive: true });
  writeFileSync(path.join(repo, 'node_modules/@mantine/core/index.d.ts'), DTS);
  const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
  pkg.scripts.typecheck = 'node typecheck.mjs';
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify(pkg, null, 2));
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  writeFileSync(path.join(repo, 'app/layout.tsx'), readFileSync(path.join(repo, 'app/layout.tsx'), 'utf8').replace("import type { ReactNode } from 'react'", "import type { ReactNode } from 'react'\nimport { MantineProvider } from '@mantine/core'"));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'mantine'], { cwd: repo });
  let sawHelp = false;
  const { res } = run(repo, [{ id: 'T1', type: 'edit', title: 'Тёмная тема', brief: 'Тёмная схема в MantineProvider', dependsOn: [], files: ['app/layout.tsx'], accept: { tests: [], commands: [] }, size: 'S' }], (_task, user) => {
    if (/## Справка по ошибке[\s\S]*defaultColorScheme\?: MantineColorScheme/.test(user)) {
      sawHelp = true;
      return json({ patches: [{ file: 'app/layout.tsx', search: '<body>{children}</body>', replace: '<body><MantineProvider defaultColorScheme="dark">{children}</MantineProvider></body>' }], note: 'по справке' });
    }
    return json({ patches: [{ file: 'app/layout.tsx', search: '<body>{children}</body>', replace: '<body><MantineProvider colorScheme="dark">{children}</MantineProvider></body>' }], note: 'по памяти' });
  });
  const r = await res;
  const journal = readFileSync(path.join(r.runDir, 'journal.txt'), 'utf8');
  assert.ok(sawHelp, journal);
  assert.deepEqual(r.done, ['T1'], journal);
  assert.match(journal, /T1: ошибка повторяется — программа поискала справку: объявления типов в установленной библиотеке/);
});

test('«Менять нечего — закрыть»: задача у человека закрывается без правки, цепочка идёт дальше', async () => {
  const repo = web();
  const tasks = [
    { id: 'T1', type: 'edit', title: 'Убрать дубли className', brief: 'b', dependsOn: [], files: [PAGE], accept: { tests: [], commands: [] }, size: 'S' },
    { id: 'T2', type: 'edit', title: 'Заголовок', brief: 'Адреса → Адреса доставки', dependsOn: ['T1'], files: [PAGE], accept: { tests: [], commands: [] }, size: 'S' },
  ];
  const coder = (task: string) =>
    task === 'T2' ? json({ patches: [{ file: PAGE, search: '<h1>Адреса</h1>', replace: '<h1>Адреса доставки</h1>' }], note: 'ok' }) : json({ patches: [{ file: PAGE, search: '<нет такого>', replace: 'x' }], note: 'мимо' });
  const first = await run(repo, tasks, coder, { runId: 'c1' }).res;
  assert.ok(first.human.some((h) => h.id === 'T1') && first.human.some((h) => h.id === 'T2'));
  const res = await run(repo, tasks, coder, { runId: 'c1', resume: true, humanClose: ['T1'] }).res;
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(res.human, [], journal);
  assert.ok(res.done.includes('T1') && res.done.includes('T2'), journal);
  assert.match(journal, /T1: закрыта без правки — человек: менять нечего/);
  assert.match(readFileSync(path.join(repo, PAGE), 'utf8'), /Адреса доставки/);
});

import { SolutionBook, cleanError, parseSection, tagsFor } from '../src/learned.ts';

test('копилка решений: запись по разделам в Markdown, чтение обратно, поиск по коду ошибки, именам и библиотеке', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ay-book-'));
  const book = new SolutionBook(dir);
  const err = cleanError(`Новые ошибки (бывшие до прогона не считаются: 2):\n${TS2322}`);
  assert.doesNotMatch(err, /app\/layout\.tsx/);
  const tags = tagsFor(TS2322, { files: ['app/layout.tsx'], imports: ['@mantine/core', 'react'], deps: { '@mantine/core': '^9.7.3', react: '^19' } });
  assert.ok(tags.includes('ts2322') && tags.includes('colorscheme') && tags.includes('mantine') && tags.includes('mantine@9') && tags.includes('tsx'), tags.join());
  const r = book.add({ id: 'ts2322-colorscheme-mantine', section: 'types', title: 'TS2322: colorScheme нет в MantineProviderProps', tags, error: err, fix: ['у MantineProvider нет colorScheme — defaultColorScheme="dark"'], example: '- <MantineProvider colorScheme="dark">\n+ <MantineProvider defaultColorScheme="dark">', sources: ['https://mantine.dev/theming/color-schemes/'], where: 'web: D2.3' });
  assert.ok(r.fresh);
  const text = readFileSync(path.join(dir, 'types.md'), 'utf8');
  assert.match(text, /^# Копилка решений: Типы и сборка/);
  assert.match(text, /- теги: ts2322, .*mantine@9/);
  const back = parseSection('types', text)[0]!;
  assert.equal(back.id, 'ts2322-colorscheme-mantine');
  assert.deepEqual(back.fix, ['у MantineProvider нет colorScheme — defaultColorScheme="dark"']);
  assert.match(back.example!, /\+ <MantineProvider defaultColorScheme="dark">/);
  // второй раз то же — счётчик, а не дубль
  assert.equal(book.add({ ...back, where: 'shop: T4' }).fresh, false);
  const again = new SolutionBook(dir);
  assert.equal(again.all().length, 1);
  assert.equal(again.all()[0]!.seen, 2);
  // поиск: та же ошибка в другом файле и проекте находится; чужая — нет
  const other = "src/app/Providers.tsx(4,40): error TS2322: Type '{ colorScheme: string; }' is not assignable to type 'IntrinsicAttributes & MantineProviderProps'. Property 'colorScheme' does not exist";
  const hit = again.search({ text: cleanError(other), tags: tagsFor(other, { imports: ['@mantine/core'], deps: { '@mantine/core': '^9.1.0' } }) });
  assert.equal(hit[0]?.s.id, 'ts2322-colorscheme-mantine');
  assert.equal(again.search({ text: "TS2304: Cannot find name 'useState'", tags: ['ts2304', 'usestate'] }).length, 0);
  assert.equal(again.byTags(['mantine', 'react'])[0]?.id, 'ts2322-colorscheme-mantine');
});

test('копилка в деле: задача прошла после ошибки типов — решение записано; в другом проекте та же ошибка — решение сразу у исполнителя', async () => {
  const book = mkdtempSync(path.join(tmpdir(), 'ay-book2-'));
  const setup = () => {
    const repo = web();
    writeFileSync(path.join(repo, 'typecheck.mjs'), `import { readFileSync } from 'node:fs';\nconst t = readFileSync('app/layout.tsx', 'utf8');\nif (t.includes('colorScheme=')) { console.log(${JSON.stringify(TS2322)}); process.exit(1); }\n`);
    const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
    pkg.scripts.typecheck = 'node typecheck.mjs';
    pkg.dependencies['@mantine/core'] = '^9.7.3';
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify(pkg, null, 2));
    writeFileSync(path.join(repo, 'app/layout.tsx'), readFileSync(path.join(repo, 'app/layout.tsx'), 'utf8').replace("import type { ReactNode } from 'react'", "import type { ReactNode } from 'react'\nimport { MantineProvider } from '@mantine/core'"));
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'mantine'], { cwd: repo });
    return repo;
  };
  const task = [{ id: 'T1', type: 'edit', title: 'Тёмная тема', brief: 'Тёмная схема в MantineProvider', dependsOn: [], files: ['app/layout.tsx'], accept: { tests: [], commands: [] }, size: 'S' }];
  const good = json({ patches: [{ file: 'app/layout.tsx', search: '<body>{children}</body>', replace: '<body><MantineProvider defaultColorScheme="dark">{children}</MantineProvider></body>' }], note: 'у MantineProvider нет colorScheme — поставил defaultColorScheme' });
  const bad = json({ patches: [{ file: 'app/layout.tsx', search: '<body>{children}</body>', replace: '<body><MantineProvider colorScheme="dark">{children}</MantineProvider></body>' }], note: 'по памяти' });
  // первый проект: сначала неверно, потом верно
  let n = 0;
  const r1 = await run(setup(), task, () => (++n === 1 ? bad : good), { learnedDir: book }).res;
  const j1 = readFileSync(path.join(r1.runDir, 'journal.txt'), 'utf8');
  assert.match(j1, /T1: записал в копилку решений — «TS2322: /);
  const saved = readFileSync(path.join(book, 'types.md'), 'utf8');
  assert.match(saved, /исполнитель: у MantineProvider нет colorScheme — поставил defaultColorScheme/);
  assert.match(saved, /\+.*defaultColorScheme="dark"/);
  // второй проект: та же ошибка — справка из копилки приходит сразу со второй попытки, без поиска в интернете
  let sawBook = false;
  let m = 0;
  const r2 = await run(setup(), task, (_t, user) => {
    m++;
    if (/Это уже решали раньше \(копилка skills\/learned\)[\s\S]*defaultColorScheme/.test(user)) {
      sawBook = true;
      return good;
    }
    return bad;
  }, { learnedDir: book }).res;
  const j2 = readFileSync(path.join(r2.runDir, 'journal.txt'), 'utf8');
  assert.ok(sawBook, j2);
  assert.match(j2, /T1: такую ошибку уже решали — беру из копилки решений/);
  assert.match(j2, /Копилка решений: учту для плана/);
  assert.ok(m <= 3, String(m));
  assert.match(readFileSync(path.join(book, 'types.md'), 'utf8'), /встречалось: 2 раз/);
});
