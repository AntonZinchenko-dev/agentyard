// Повтор прогона 20.10 02:50: «сделай таблици красивыми, обернув их в какой нидуь юай кит».
// Что сломалось тогда: задача «поставить пакеты» стёрла общий CSS (пустой search + пустой replace),
// gpt-oss прислал layout.tsx одной строкой с буквальными \n, шаблон с * попал прямо в files
// (границы задачи не сходились), в «проверку» попал sed, а задачи после проваленной молча висели.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPatches, unescapeFlat } from '../src/tools/patch.ts';
import { expandGlobTasks, foldInstallTasks, isCheckCommand, isWrapperFile, validatePlan } from '../src/plan.ts';
import { createWebRepo } from '../src/demo.ts';
import { listFiles } from '../src/tools/fs.ts';
import { MockRuntime } from '../src/runtime/mock.ts';
import { Pipeline } from '../src/pipeline.ts';
import { loadCatalog } from '../src/catalog.ts';
import { Stats } from '../src/stats.ts';
import type { ChatMessage, ChatRequest } from '../src/runtime/types.ts';
import type { Hardware, Plan, PlannedTask } from '../src/types.ts';

process.env.AGENTYARD_NPM = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-npm.mjs');
const HW: Hardware = { gpuName: 'test', vramTotalGb: 48, vramFreeGb: 48, ramTotalGb: 64, ramFreeGb: 32, cpuCores: 8, unifiedMemory: false, tier: 'T3' };

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'ay-uikit-'));
}

function web(): string {
  const dir = path.join(tmp(), 'web');
  createWebRepo(dir);
  return dir;
}

const task = (o: Partial<PlannedTask> & { id: string }): PlannedTask => ({
  type: 'edit',
  title: o.id,
  brief: '',
  dependsOn: [],
  files: [],
  accept: { tests: [], commands: [] },
  size: 'S',
  ...o,
});

test('заплатки: пустой replace не стирает файл, буквальные \\n становятся строками, all меняет каждое вхождение, пустая правка — не работа', () => {
  const root = tmp();
  mkdirSync(path.join(root, 'src'));
  const css = Array.from({ length: 28 }, (_, i) => `.r${i} { color: red; }`).join('\n') + '\n';
  writeFileSync(path.join(root, 'src/a.css'), css);
  writeFileSync(path.join(root, 'src/p.tsx'), '<table>\n  <tr><th>a</th><th>b</th></tr>\n</table>\n');

  // T1 тогда: {"search": "", "replace": ""} — «No changes applied», а файл стал пустым
  const wipe = applyPatches(root, [{ file: 'src/a.css', search: '', replace: '' }]);
  assert.equal(wipe.ok, false);
  assert.match(wipe.errors[0]!, /стирает весь файл/);
  // переписать стили «покороче» — тоже потеря правил
  const shrink = applyPatches(root, [{ file: 'src/a.css', search: '', replace: '.r0 { color: blue; }\n' }]);
  assert.equal(shrink.ok, false);
  assert.equal(readFileSync(path.join(root, 'src/a.css'), 'utf8'), css);

  // gpt-oss: весь файл одной строкой с буквальными \n — tsc видел «Invalid character» в строке 1
  const flat = "'use client'\\nimport type { ReactNode } from 'react'\\n\\nexport default function L() {\\n  return null\\n}\\n";
  assert.equal(unescapeFlat(flat).split('\n').length, 7);
  assert.equal(unescapeFlat("a.split('\\n')"), "a.split('\\n')", 'одна \\n в однострочном коде — настоящая строка JS, не трогаем');
  const created = applyPatches(root, [{ file: 'src/layout.tsx', search: '', replace: flat }]);
  assert.ok(created.ok);
  assert.equal(readFileSync(path.join(root, 'src/layout.tsx'), 'utf8').split('\n')[1], "import type { ReactNode } from 'react'");

  // all: каждый <th> → <Table.Th>
  const all = applyPatches(root, [
    { file: 'src/p.tsx', search: '<th>', replace: '<Table.Th>', all: true },
    { file: 'src/p.tsx', search: '</th>', replace: '</Table.Th>', all: true },
  ]);
  assert.ok(all.ok, all.errors.join('\n'));
  assert.equal(readFileSync(path.join(root, 'src/p.tsx'), 'utf8'), '<table>\n  <tr><Table.Th>a</Table.Th><Table.Th>b</Table.Th></tr>\n</table>\n');
  // без all повтор — понятная подсказка про all
  const many = applyPatches(root, [{ file: 'src/p.tsx', search: '<Table.Th>', replace: '<th>' }]);
  assert.match(many.errors[0]!, /all: true/);

  const noop = applyPatches(root, [{ file: 'src/p.tsx', search: '<table>', replace: '<table>' }]);
  assert.equal(noop.ok, false);
  assert.match(noop.errors[0]!, /ничего не меняют/);
});

test('план: шаблон в files → правка по образцу; разные виды страниц — подгруппы; обёртки и страницы без таблиц не трогаем', () => {
  const dir = web();
  const all = listFiles(dir);
  const read = (f: string) => readFileSync(path.join(dir, f), 'utf8');
  assert.ok(isWrapperFile(read('app/(generated)/addresses/page.tsx')));
  assert.ok(!isWrapperFile(read('src/pages/address-list/ui/AddressListPage.tsx')));

  const warnings: string[] = [];
  const plan: Plan = {
    goal: 'x',
    tasks: [
      task({ id: 'T3a', title: 'Заменить кнопки на Mantine Button в UI страницах', files: ['src/pages/*/ui/*.tsx'] }),
      task({ id: 'T3b', title: 'Заменить кнопки на Mantine Button в сгенерированных страницах', files: ['app/(generated)/*/page.tsx'] }),
      task({ id: 'T4a', title: 'Заменить таблицы на Mantine Table', brief: 'Каждую <table className="af-table"> заменить на Table', files: ['src/pages/*/ui/*Page.tsx', 'src/pages/address-list/ui/AddressListPage.tsx'], dependsOn: ['T3a', 'T3b'] }),
    ],
  };
  const out = expandGlobTasks(plan, all, read, warnings).tasks;
  const byId = new Map(out.map((t) => [t.id, t]));
  // кнопки есть и в списках, и в формах: две подгруппы, у каждой свой образец
  assert.equal(byId.get('T3a')?.similar, 'src/pages/*-edit/ui/*.tsx');
  assert.deepEqual(byId.get('T3a')?.files, ['src/pages/address-edit/ui/AddressEditPage.tsx']);
  assert.equal(byId.get('T3a-list')?.similar, 'src/pages/*-list/ui/*.tsx');
  // обёртки маршрутов — без разметки, задача убрана
  assert.ok(!byId.has('T3b'), warnings.join('\n'));
  // таблицы только в списках: формы не трогаем, образец — тот, что назвала модель
  const t4 = byId.get('T4a')!;
  assert.equal(t4.similar, 'src/pages/*-list/ui/*Page.tsx');
  assert.deepEqual(t4.files, ['src/pages/address-list/ui/AddressListPage.tsx']);
  assert.ok(!byId.has('T4a-edit'));
  assert.deepEqual(t4.dependsOn.sort(), ['T3a', 'T3a-list']);
  assert.ok(out.every((t) => t.files.every((f) => !f.includes('*'))));
});

test('план: отдельная «поставить пакеты» сливается со следующей задачей; sed в проверках выбрасывается', () => {
  const warnings: string[] = [];
  const folded = foldInstallTasks(
    { goal: 'x', tasks: [task({ id: 'T1', title: 'Установить Mantine', install: ['@mantine/core'] }), task({ id: 'T2', files: ['app/layout.tsx'], dependsOn: ['T1'] })] },
    warnings,
  ).tasks;
  assert.deepEqual(folded.map((t) => t.id), ['T2']);
  assert.deepEqual(folded[0]!.install, ['@mantine/core']);
  assert.deepEqual(folded[0]!.dependsOn, []);

  const cmds = { test: null, testFiles: null, lint: null, typecheck: 'npx --no-install tsc --noEmit' };
  assert.ok(isCheckCommand('npx --no-install tsc --noEmit', cmds));
  assert.ok(isCheckCommand('npm test', cmds));
  assert.ok(!isCheckCommand(`sed -E 's/className="af-btn( primary| danger)?"/ /g'`, cmds));
  assert.ok(!isCheckCommand('rm -rf src', cmds));
  assert.ok(!isCheckCommand('echo ok > x', cmds));

  const dir = web();
  const check = validatePlan(
    { goal: 'x', tasks: [task({ id: 'D2.1', title: 'Заменить af-btn на Button', files: ['src/pages/*/ui/*.tsx'], accept: { tests: [], commands: [`sed -E 's/af-btn/ /g'`] } })] },
    dir,
    'T2',
    cmds,
  );
  assert.ok(check.ok, check.errors.join('\n'));
  assert.ok(check.plan.tasks.every((t) => t.accept.commands.length === 0));
  assert.ok(check.plan.tasks.every((t) => !(t.newFiles ?? []).some((f) => f.includes('*'))), 'шаблон не должен считаться «новым файлом»');
});

/** Модели ведут себя как в том прогоне: план с отдельной установкой и шаблонами в files, gpt-oss экранирует \n дважды. */
function script(seen: { coderTasks: string[]; goalChecks: number }) {
  return (req: ChatRequest): ChatMessage => {
    const system = req.messages[0]?.content ?? '';
    const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
    const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
    if (system.includes('планировщик')) {
      return json({
        understanding: 'Добавить Mantine, обернуть приложение в MantineProvider, заменить таблицы af-table на Mantine Table.',
        tasks: [
          { id: 'T1', type: 'edit', title: 'Установить Mantine', brief: 'Поставить пакеты', dependsOn: [], files: [], install: ['@mantine/core', '@mantine/hooks'], accept: { tests: [], commands: [] }, size: 'S' },
          { id: 'T2', type: 'edit', title: 'Обернуть RootLayout в MantineProvider', brief: 'MantineProvider и стили', dependsOn: ['T1'], files: ['app/layout.tsx'], accept: { tests: [], commands: [] }, size: 'S' },
          { id: 'T3', type: 'edit', title: 'Заменить таблицы на Mantine Table', brief: '<table className="af-table"> → <Table>', dependsOn: ['T2'], files: ['src/pages/*/ui/*.tsx'], accept: { tests: [], commands: [] }, size: 'M' },
          { id: 'T4', type: 'edit', title: 'Таблицы в сгенерированных страницах', brief: 'то же в app', dependsOn: ['T2'], files: ['app/(generated)/*/page.tsx'], accept: { tests: [], commands: [] }, size: 'S' },
        ],
      });
    }
    if (system.includes('приёмщик')) {
      seen.goalChecks += 1;
      return json({ achieved: true, missing: [], tasks: [] });
    }
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('кодер')) {
      const id = /## Задача\s+(\S+?):/.exec(user)?.[1] ?? '?';
      seen.coderTasks.push(id);
      if (/Провайдер|MantineProvider/i.test(/## Задача\s+[^\n]+/.exec(user)?.[0] ?? '')) {
        // двойная экранировка, как у gpt-oss
        const layout = "import type { ReactNode } from 'react'\\nimport '@mantine/core/styles.css'\\nimport { MantineProvider } from '@mantine/core'\\n\\nexport const metadata = { title: 'Учебный сайт' }\\n\\nexport default function RootLayout({ children }: { children: ReactNode }) {\\n  return (\\n    <html lang=\"ru\">\\n      <body>\\n        <MantineProvider>{children}</MantineProvider>\\n      </body>\\n    </html>\\n  )\\n}\\n";
        return json({ patches: [{ file: 'app/layout.tsx', search: '', replace: layout }], note: 'provider' });
      }
      const f = 'src/pages/address-list/ui/AddressListPage.tsx';
      const p = (search: string, replace: string) => ({ file: f, search, replace, all: true });
      return json({
        patches: [
          { file: f, search: "import Link from 'next/link'", replace: "import Link from 'next/link'\nimport { Table } from '@mantine/core'" },
          p('<table className="af-table">', '<Table striped highlightOnHover withTableBorder>'),
          p('</table>', '</Table>'),
          p('<thead>', '<Table.Thead>'),
          p('</thead>', '</Table.Thead>'),
          p('<tbody>', '<Table.Tbody>'),
          p('</tbody>', '</Table.Tbody>'),
          p('<tr', '<Table.Tr'),
          p('</tr>', '</Table.Tr>'),
          p('<th>', '<Table.Th>'),
          p('</th>', '</Table.Th>'),
          p('<td', '<Table.Td'),
          p('</td>', '</Table.Td>'),
        ],
        note: 'Mantine Table',
      });
    }
    return json({});
  };
}

test('«сделай таблици красивыми, обернув их в какой нидуь юай кит»: пакеты, провайдер, таблицы во всех списках — и сразу в проекте', async () => {
  const dir = web();
  const css = readFileSync(path.join(dir, 'src/shared/ui/generated.css'), 'utf8');
  const editBefore = readFileSync(path.join(dir, 'src/pages/user-edit/ui/UserEditPage.tsx'), 'utf8');
  const seen = { coderTasks: [] as string[], goalChecks: 0 };
  const runtime = new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], script(seen));
  const res = await new Pipeline({
    repo: dir,
    goal: 'сделай таблици красивыми, обернув их в какой нидуь юай кит',
    runtime,
    catalog: loadCatalog(),
    hardware: HW,
    stats: new Stats(null),
    quiet: true,
    autoApply: true,
    allowInstall: true,
  }).run();
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(res.human, [], journal);
  assert.ok(res.applied?.ok, journal);
  assert.match(journal, /поставит программа перед T2/);
  assert.match(journal, /обёртки без разметки/);

  // общий CSS цел, layout — нормальный многострочный файл с провайдером
  assert.equal(readFileSync(path.join(dir, 'src/shared/ui/generated.css'), 'utf8'), css);
  const layout = readFileSync(path.join(dir, 'app/layout.tsx'), 'utf8');
  assert.ok(layout.split('\n').length > 10, layout);
  assert.match(layout, /<MantineProvider>\{children\}<\/MantineProvider>/);
  // таблицы — Mantine во всех шести списках, формы не тронуты
  for (const e of ['Address', 'User', 'Order', 'Product', 'Payment', 'Review']) {
    const one = e.toLowerCase();
    const page = readFileSync(path.join(dir, `src/pages/${one}-list/ui/${e}ListPage.tsx`), 'utf8');
    assert.match(page, /<Table striped highlightOnHover withTableBorder>/, `${e}: ${page.slice(0, 400)}`);
    assert.match(page, /import \{ Table \} from '@mantine\/core'/);
    assert.ok(!/<\/?t(able|head|body|r|h|d)[\s>]/.test(page), `${e}: остались html-теги таблицы`);
  }
  assert.equal(readFileSync(path.join(dir, 'src/pages/user-edit/ui/UserEditPage.tsx'), 'utf8'), editBefore);
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['@mantine/core']);
  assert.ok(existsSync(path.join(dir, 'node_modules/@mantine/core/package.json')));
  // модель не звали ради установки пакетов
  assert.ok(!seen.coderTasks.includes('T1'), seen.coderTasks.join(','));
});

test('задача, которая ждёт проваленную, не висит молча: уходит человеку с причиной', async () => {
  const dir = web();
  const runtime = new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], (req) => {
    const system = req.messages[0]?.content ?? '';
    const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
    if (system.includes('планировщик')) {
      return json({
        understanding: 'x',
        tasks: [
          { id: 'T1', type: 'edit', title: 'Провайдер', brief: 'b', dependsOn: [], files: ['app/layout.tsx'], accept: { tests: [], commands: [] }, size: 'S' },
          { id: 'T2', type: 'edit', title: 'Кнопки', brief: 'b', dependsOn: ['T1'], files: ['src/pages/address-list/ui/AddressListPage.tsx'], accept: { tests: [], commands: [] }, size: 'S' },
        ],
      });
    }
    if (system.includes('приёмщик')) return json({ achieved: false, missing: ['ничего не сделано'], tasks: [] });
    // кодер всегда промахивается мимо файла
    if (system.includes('кодер')) return json({ patches: [{ file: 'app/layout.tsx', search: 'нет такого', replace: 'x' }], note: 'x' });
    return json({});
  });
  const res = await new Pipeline({ repo: dir, goal: 'натяни мантину', runtime, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true }).run();
  const t2 = res.human.find((h) => h.id === 'T2');
  assert.ok(t2, JSON.stringify(res.human));
  assert.match(t2!.why, /не начата: зависит от T1/);
});

test('по образцу на шаблон со списками и формами: где фрагмента и похожего места нет — пропуск, а не лишняя задача', async () => {
  const { replicate } = await import('../src/replicate.ts');
  const dir = web();
  const example = 'src/pages/address-list/ui/AddressListPage.tsx';
  const glob = 'src/pages/*/ui/*Page.tsx';
  const targets = listFiles(dir).filter((f) => /^src\/pages\/.*Page\.tsx$/.test(f) && f !== example);
  const r = replicate(dir, glob, example, [{ file: example, search: '          Добавить\n', replace: '          Создать\n' }], targets);
  assert.equal(r.applied.length, 5, JSON.stringify(r));
  assert.equal(r.skipped.length, 6, 'формы: кнопки «Добавить» там нет');
  assert.equal(r.failed.length, 0);

  // явный similar на весь шаблон, надпись «Добавить» есть только в списках — сужаем до списков
  const out = expandGlobTasks(
    { goal: 'x', tasks: [task({ id: 'T1', title: 'везде где кнопка Добавить пусть будет Создать', files: [example], similar: glob })] },
    listFiles(dir),
    (f) => readFileSync(path.join(dir, f), 'utf8'),
  ).tasks;
  assert.deepEqual(out.map((t) => [t.id, t.similar, t.files[0]]), [['T1', 'src/pages/*-list/ui/*Page.tsx', example]]);
});
