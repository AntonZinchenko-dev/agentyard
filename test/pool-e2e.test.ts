// Рабочий алгоритм целиком на учебном сайте: повтор прогона 20261020053801
// («таблицы обернуть в юайкит»), где 16 однотипных задач гонялись по статусам и не доделывались.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWebRepo } from '../src/demo.ts';
import { MockRuntime } from '../src/runtime/mock.ts';
import { Pipeline } from '../src/pipeline.ts';
import { loadCatalog } from '../src/catalog.ts';
import { Stats } from '../src/stats.ts';
import type { ChatMessage, ChatRequest } from '../src/runtime/types.ts';
import type { Hardware } from '../src/types.ts';

const HW: Hardware = { gpuName: 'test', vramTotalGb: 16, vramFreeGb: 16, ramTotalGb: 32, ramFreeGb: 24, cpuCores: 8, unifiedMemory: false, tier: 'T2' }; // как у RTX 5080 16 ГБ: лимит 80 строк на правку
const LIST = 'src/pages/*-list/ui/*ListPage.tsx';
const ENT = ['address', 'user', 'order', 'product', 'payment', 'review'];
const page = (e: string) => `src/pages/${e}-list/ui/${e[0]!.toUpperCase()}${e.slice(1)}ListPage.tsx`;
const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });

function toMantine(text: string): string {
  return text
    .replace("import Link from 'next/link'\n", "import Link from 'next/link'\nimport { Table } from '@mantine/core'\n")
    .replace('<table className="af-table">', '<Table striped highlightOnHover withTableBorder>')
    .replace('</table>', '</Table>')
    .replace(/<(\/?)thead>/g, '<$1Table.Thead>')
    .replace(/<(\/?)tbody>/g, '<$1Table.Tbody>')
    .replace(/<tr>/g, '<Table.Tr>')
    .replace(/<tr key/g, '<Table.Tr key')
    .replace(/<\/tr>/g, '</Table.Tr>')
    .replace(/<(\/?)th>/g, '<$1Table.Th>')
    .replace(/<(\/?)td>/g, '<$1Table.Td>');
}

function web(): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'ay-pool-')), 'web');
  createWebRepo(dir);
  return dir;
}

function commit(dir: string, msg: string): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', msg], { cwd: dir });
}

function pipeline(repo: string, goal: string, script: (system: string, user: string) => ChatMessage) {
  const calls: { role: string; task: string; user: string }[] = [];
  const rt = new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], (req: ChatRequest) => {
    const system = req.messages[0]?.content ?? '';
    const user = req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const role = system.includes('приёмщик') ? 'goal' : system.includes('ревьюер') ? 'reviewer' : system.includes('планировщик') ? 'planner' : system.includes('аналитик') ? 'analyst' : 'coder';
    calls.push({ role, task: /## Задача\s+(\S+?):/.exec(user)?.[1] ?? '', user });
    if (role === 'goal') return json({ achieved: true, missing: [], tasks: [] });
    return script(system, user);
  });
  const p = new Pipeline({ repo, goal, runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, autoApply: true });
  return { calls, run: () => p.run() };
}

test('пул по образцу: модель правит один файл (даже целиком), программа повторяет решение, остаток — атомы с шагами, ревьюер не сбивает', async () => {
  const repo = web();
  // в одной странице — вариант, которого нет в образце: программа её не осилит, нужна модель
  const odd = page('user');
  writeFileSync(path.join(repo, odd), readFileSync(path.join(repo, odd), 'utf8').replace('<td>{String(row.created_at)}</td>', '<td className="num">{String(row.created_at)}</td>'));
  commit(repo, 'вариант');
  const original = Object.fromEntries(ENT.map((e) => [e, readFileSync(path.join(repo, page(e)), 'utf8')]));

  let attemptsOdd = 0;
  let falseReview = true;
  const { calls, run } = pipeline(repo, 'Надо таблицы обернуть в какой-нибудь юайкит и сделать красивую ашпку', (system, user) => {
    if (system.includes('планировщик')) {
      return json({
        understanding: 'Таблицы списков — на Mantine Table, провайдер в layout.',
        tasks: [
          { id: 'T1', type: 'edit', title: 'MantineProvider в layout', brief: 'Обернуть children в MantineProvider', dependsOn: [], files: ['app/layout.tsx'], accept: { tests: [], commands: [] }, size: 'S' },
          { id: 'T2', type: 'edit', title: 'Таблицы списков на Mantine Table', brief: 'Заменить <table> на Table из @mantine/core', dependsOn: ['T1'], files: [page('address')], similar: LIST, accept: { tests: [], commands: [] }, size: 'M' },
        ],
      });
    }
    if (system.includes('ревьюер')) {
      // маленький ревьюер ошибается, глядя на diff: «нет импорта Table» (импорт есть)
      if (/## Задача\s+T2:/.test(user) && falseReview) {
        falseReview = false;
        return json({ verdict: 'changes', reasons: ['В файле заменены HTML-теги на компоненты Mantine Table, но отсутствует импорт компонента `Table` из @mantine/core.', 'Only address-list was updated; other list pages (order-list, user-list) still use plain <table>.'] });
      }
      return json({ verdict: 'approve', reasons: [] });
    }
    const task = /## Задача\s+(\S+?):/.exec(user)?.[1];
    if (task === 'T1') {
      return json({ patches: [{ file: 'app/layout.tsx', search: '<body>{children}</body>', replace: '<body>\n        <MantineProvider>{children}</MantineProvider>\n      </body>' }, { file: 'app/layout.tsx', search: "import type { ReactNode } from 'react'\n", replace: "import type { ReactNode } from 'react'\nimport { MantineProvider } from '@mantine/core'\n" }], note: 'провайдер' });
    }
    if (task === 'T2') {
      // как в настоящем прогоне: файл целиком — раньше из-за этого повтор «не подходил» ни к одному файлу
      return json({ patches: [{ file: page('address'), search: '', replace: toMantine(original.address!) }], note: 'Replaced entire file with Mantine Table implementation' });
    }
    if (task === 'T2.p1') {
      attemptsOdd += 1;
      assert.match(user, /## Шаги/);
      assert.match(user, /## Решение-образец/);
      assert.match(user, /## Готово, когда/);
      assert.match(user, /Это одна из \d+ однотипных задач/);
      assert.match(user, /T1 «MantineProvider в layout»/, 'решение T1 видно атомам пула');
      const fixed = toMantine(original.user!);
      // первая попытка — небрежная: <td className="num"> забыт; признаки готовности это ловят
      const text = attemptsOdd === 1 ? fixed : fixed.replace('<td className="num">', '<Table.Td className="num">');
      return json({ patches: [{ file: odd, search: '', replace: text }], note: 'таблица' });
    }
    return json({ patches: [], note: 'нечего' });
  });
  const res = await run();
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');

  assert.deepEqual(res.human, [], journal);
  assert.deepEqual(res.done.sort(), ['T1', 'T2', 'T2.p1'], journal);
  assert.doesNotMatch(journal, /T2\.p1'|T2\.p2/, 'никаких дублей и лишних задач');
  assert.match(journal, /решение из src\/pages\/address-list\/ui\/AddressListPage\.tsx программа повторила ещё в 4 файл/);
  assert.match(journal, /в 1 не подошло \(UserListPage\.tsx: остались <td\)/);
  assert.match(journal, /программа проверила причины ревью — «В файле заменены.*неверно: импорт или объявление есть в файле/);
  assert.match(journal, /Only address-list was updated.*неверно: остальные файлы программа сделает по образцу/);
  assert.match(journal, /T2\.p1: провал на ступени 2 \(признаки готовности\)/);
  assert.match(journal, /Ревью T2\.p1 не нужно: повтор решения, принятого на T2/);
  assert.equal(attemptsOdd, 2);
  // модель правила только образец и один особый файл
  assert.deepEqual([...new Set(calls.filter((c) => c.role === 'coder').map((c) => c.task))].sort(), ['T1', 'T2', 'T2.p1']);
  for (const e of ENT) {
    const t = readFileSync(path.join(repo, page(e)), 'utf8');
    assert.ok(t.includes("import { Table } from '@mantine/core'") && t.includes('<Table striped') && !/<table|<td|<tr[ >]/.test(t), `${e}: ${t.slice(0, 400)}`);
  }
  // строгий порядок: ни одна задача не начата, пока не доделана предыдущая в очереди
  const order = [...journal.matchAll(/берёт задачу (\S+)\./g)].map((m) => m[1]);
  assert.equal(order.indexOf('T2.p1') > order.lastIndexOf('T2'), true, order.join(' '));
});

test('классификатор: план из одинаковых задач по страницам — модель делает одну, остальные программа', async () => {
  const repo = web();
  const original = readFileSync(path.join(repo, page('address')), 'utf8');
  const tasks = ['address', 'order', 'product'].map((e, i) => ({
    id: `T${i + 1}`,
    type: 'edit',
    title: `Обернуть таблицу на странице ${e}-list в Mantine Table`,
    brief: `Заменить <table> на Table из @mantine/core на странице ${e}`,
    dependsOn: [],
    files: [page(e)],
    accept: { tests: [], commands: [] },
    size: 'S',
  }));
  const { calls, run } = pipeline(repo, 'таблицы адресов, заказов и товаров — на Mantine', (system, user) => {
    if (system.includes('планировщик')) return json({ understanding: 'три таблицы', tasks });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (/## Задача\s+T1:/.test(user)) return json({ patches: [{ file: page('address'), search: '', replace: toMantine(original) }], note: 'ok' });
    throw new Error(`модель не должна делать ${/## Задача\s+(\S+?):/.exec(user)?.[1]}`);
  });
  const res = await run();
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(res.done.sort(), ['T1', 'T2', 'T3'], journal);
  assert.match(journal, /Классификатор: T1, T2, T3 — одна и та же правка/);
  assert.match(journal, /программа повторила в задачах T2, T3/);
  assert.deepEqual([...new Set(calls.filter((c) => c.role === 'coder').map((c) => c.task))], ['T1']);
  for (const e of ['order', 'product']) assert.match(readFileSync(path.join(repo, page(e)), 'utf8'), /<Table striped/);
  // каждая задача пула — своим коммитом (откат и поиск виновного точные)
  const log = execFileSync('git', ['log', '--format=%s', `${res.branch}`], { cwd: repo }).toString();
  assert.match(log, /^T2: /m);
  assert.match(log, /^T3: /m);
});

test('матрёшка: части получают решения соседей и место в работе, задача собирается из частей', async () => {
  const repo = web();
  const PAGE = page('address');
  let firstPlan = true;
  const { calls, run } = pipeline(repo, 'заголовок адресов через общий компонент', (system, user) => {
    if (system.includes('планировщик')) {
      if (firstPlan) {
        firstPlan = false;
        return json({ understanding: 'заголовок', tasks: [{ id: 'T1', type: 'edit', title: 'Заголовок через компонент', brief: 'Вынести заголовок в компонент', dependsOn: [], files: [PAGE], accept: { tests: [], commands: [] }, size: 'M' }] });
      }
      assert.match(user, /атом/);
      return json({
        understanding: 'по частям',
        tasks: [
          { id: 'A', type: 'edit', title: 'Компонент PageTitle', brief: 'Создать компонент', dependsOn: [], files: ['src/shared/ui/PageTitle.tsx'], newFiles: ['src/shared/ui/PageTitle.tsx'], accept: { tests: [], commands: [] }, size: 'S', steps: ['Создай файл', 'Экспортируй PageTitle'] },
          { id: 'B', type: 'edit', title: 'Заголовок через PageTitle', brief: 'Использовать компонент', dependsOn: ['A'], files: [PAGE], accept: { tests: [], commands: [] }, size: 'S' },
        ],
      });
    }
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    const task = /## Задача\s+(\S+?):/.exec(user)?.[1];
    if (task === 'T1.1') {
      assert.match(user, /## Шаги \(делай по порядку\)\n\n1\. Создай файл/);
      assert.match(user, /Это часть задачи T1/);
      return json({ patches: [{ file: 'src/shared/ui/PageTitle.tsx', search: '', replace: "export function PageTitle({ text }: { text: string }) {\n  return <h1>{text}</h1>\n}\n" }], note: 'компонент' });
    }
    if (task === 'T1.2') {
      // решение соседней части видно: компонент уже создан — второй такой же не нужен
      assert.match(user, /T1\.1 «Компонент PageTitle».*создан src\/shared\/ui\/PageTitle\.tsx \(экспорт: PageTitle\)/);
      return json({ patches: [{ file: PAGE, search: '<h1>Адреса</h1>', replace: '<PageTitle text="Адреса" />' }, { file: PAGE, search: "import Link from 'next/link'\n", replace: "import Link from 'next/link'\nimport { PageTitle } from '../../../shared/ui/PageTitle'\n" }], note: 'ok' });
    }
    // T1 целиком не выходит — после всех ступеней планировщик предлагает другой путь частями
    return json({ patches: [{ file: PAGE, search: '<h1>Нет такого</h1>', replace: 'x' }], note: 'мимо' });
  });
  const res = await run();
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(res.human, [], journal);
  assert.deepEqual(res.done.sort(), ['T1', 'T1.1', 'T1.2'], journal);
  assert.match(journal, /T1: собрана из частей T1\.1, T1\.2 — решения частей переданы наверх/);
  assert.ok(calls.some((c) => c.task === 'T1.2'));
  assert.match(readFileSync(path.join(repo, PAGE), 'utf8'), /<PageTitle text="Адреса" \/>/);
});

test('повтор по образцу ломает проверку типов в одном файле — откатывается только он, он же идёт атомом к модели', async () => {
  const repo = web();
  // проверка типов проекта: «Table без импорта» и особый случай в товарах ломают сборку (как tsc: путь(строка,столбец): error)
  writeFileSync(
    path.join(repo, 'typecheck.mjs'),
    `import { readFileSync, readdirSync } from 'node:fs';
let bad = 0;
for (const d of readdirSync('src/pages')) {
  if (!d.endsWith('-list')) continue;
  const e = d.slice(0, -5);
  const f = 'src/pages/' + d + '/ui/' + e[0].toUpperCase() + e.slice(1) + 'ListPage.tsx';
  const t = readFileSync(f, 'utf8');
  if (t.includes('<Table') && (!t.includes("import { Table }") || t.includes('ЛОМАЕТСЯ'))) { console.log(f + "(1,1): error TS2304: Cannot find name 'Table'."); bad++; }
}
process.exit(bad ? 1 : 0);
`,
  );
  const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
  pkg.scripts.typecheck = 'node typecheck.mjs';
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify(pkg, null, 2));
  const prod = page('product');
  writeFileSync(path.join(repo, prod), readFileSync(path.join(repo, prod), 'utf8').replace('const PAGE = 20', '// ЛОМАЕТСЯ с Mantine (условно)\nconst PAGE = 20'));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  commit(repo, 'проверка типов');
  const original = readFileSync(path.join(repo, page('address')), 'utf8');
  let prodCalls = 0;
  const { run } = pipeline(repo, 'таблицы списков на Mantine', (system, user) => {
    if (system.includes('планировщик')) {
      return json({ understanding: 'таблицы', tasks: [{ id: 'T1', type: 'edit', title: 'Таблицы списков на Mantine', brief: 'Table из @mantine/core', dependsOn: [], files: [page('address')], similar: LIST, accept: { tests: [], commands: [] }, size: 'M' }] });
    }
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (/## Задача\s+T1:/.test(user)) return json({ patches: [{ file: page('address'), search: '', replace: toMantine(original) }], note: 'ok' });
    if (/## Задача\s+T1\.p1:/.test(user)) {
      prodCalls++;
      const t = readFileSync(path.join(repo, prod), 'utf8');
      return json({ patches: [{ file: prod, search: '', replace: toMantine(t).replace('// ЛОМАЕТСЯ с Mantine (условно)\n', '') }], note: 'товары' });
    }
    throw new Error('лишний вызов модели');
  });
  const res = await run();
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(res.done.sort(), ['T1', 'T1.p1'], journal);
  assert.match(journal, /программа повторила ещё в 4 файл/, journal);
  assert.match(journal, /ProductListPage\.tsx: проверки: .*TS2304/, journal);
  assert.equal(prodCalls, 1);
  for (const e of ENT) assert.match(readFileSync(path.join(repo, page(e)), 'utf8'), /<Table striped/, e);
});

test('эпохи моделей: 6 независимых задач — модель делает всё, что может, подряд; смен модели — единицы, а не по две на задачу', async () => {
  const repo = web();
  const ents = ['address', 'user', 'order', 'product', 'payment', 'review'];
  const tasks = ents.map((e, i) => ({ id: `T${i + 1}`, type: 'edit', title: `Заголовок ${e}`, brief: `уникальная правка ${i}`, dependsOn: [], files: [page(e)], accept: { tests: [], commands: [] }, size: 'M' }));
  const { run } = pipeline(repo, 'заголовки', (system, user) => {
    if (system.includes('планировщик')) return json({ understanding: 'x', tasks });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    const id = /## Задача\s+T(\d+):/.exec(user)?.[1];
    const e = ents[Number(id) - 1]!;
    return json({ patches: [{ file: page(e), search: '</h1>', replace: ` (${id})</h1>` }], note: 'ok' });
  });
  const res = await run();
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.equal(res.done.length, 6, journal);
  assert.ok(res.swaps <= 4, `смен модели: ${res.swaps}\n${journal}`);
  assert.match(journal, /смена модели на [^:]+:[^:]+: у неё \d+ шаг\(ов\) работы/);
});

test('«Отправить на доработку»: прогон продолжается — планировщик берёт просьбу и замечания приёмки, результат применяется поверх; приёмка видит факты по всем файлам', async () => {
  const repo = web();
  const goalPrompts: string[] = [];
  let reworkPrompt = '';
  const rt = (achieved: boolean) =>
    new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], (req: ChatRequest) => {
      const system = req.messages[0]?.content ?? '';
      const user = req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
      if (system.includes('приёмщик')) {
        goalPrompts.push(user);
        return json(achieved ? { achieved: true, missing: [], tasks: [] } : { achieved: false, missing: ['шапка не стилизована'], tasks: [] });
      }
      if (system.includes('планировщик')) {
        if (/ДОРАБОТКА \(раунд 1\)/.test(user)) {
          reworkPrompt = user;
          return json({ understanding: 'шапка', tasks: [{ id: 'T1', type: 'edit', title: 'Шапка', brief: 'класс шапки', dependsOn: [], files: [page('address')], accept: { tests: [], commands: [] }, size: 'S' }] });
        }
        return json({ understanding: 'таблицы', tasks: [{ id: 'T1', type: 'edit', title: 'Таблицы', brief: 'Table', dependsOn: [], files: [page('address')], similar: LIST, accept: { tests: [], commands: [] }, size: 'M' }] });
      }
      if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
      if (/## Задача\s+R1\.1:/.test(user)) return json({ patches: [{ file: page('address'), search: '<div className="af-head">', replace: '<div className="af-head pretty">' }], note: 'шапка' });
      return json({ patches: [{ file: page('address'), search: '', replace: toMantine(readFileSync(path.join(repo, page('address')), 'utf8')) }], note: 'таблица' });
    });
  const base = { repo, goal: 'таблицы на mantine и шапку', catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, autoApply: true };
  const res1 = await new Pipeline({ ...base, runtime: rt(false) }).run();
  assert.equal(res1.goal?.achieved, false);
  assert.ok(goalPrompts.some((u) => /«<table» убрано из 6 файлов; в коде проекта осталось в 0 файл\(ах\) — нигде/.test(u)), goalPrompts.at(-1) ?? "");
  assert.match(goalPrompts.at(-1)!, /изменены однотипные файлы: src\/pages\/\*-list\/ui\/\*ListPage\.tsx — 6 шт\./);

  const res2 = await new Pipeline({ ...base, runtime: rt(true), runId: path.basename(res1.runDir), resume: true, rework: 'шапку сделай красивой' }).run();
  const journal = readFileSync(path.join(res2.runDir, 'journal.txt'), 'utf8');
  assert.match(reworkPrompt, /Человек просит доделать \(это главное\): шапку сделай красивой/);
  assert.match(reworkPrompt, /- шапка не стилизована/);
  assert.match(journal, /Доработка \(раунд 1\) по просьбе человека: «шапку сделай красивой»; приёмка: шапка не стилизована\. Задачи: R1\.1\./);
  assert.ok(res2.done.includes('R1.1'), journal);
  assert.ok(res2.applied?.ok, journal);
  const t = readFileSync(path.join(repo, page('address')), 'utf8');
  assert.match(t, /af-head pretty/);
  assert.match(t, /<Table striped/, 'прежний результат на месте');
});
