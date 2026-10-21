// Рабочий алгоритм: общее решение пула (правила из образца), классификатор однотипных задач,
// строгий конвейер, журнал решений матрёшки, проверка причин ревью фактами.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWebRepo } from '../src/demo.ts';
import { applyRules, fits, learnRules, rulesDoneWhen, rulesSteps } from '../src/rules.ts';
import { entityPairs } from '../src/replicate.ts';
import { classify, fileTemplate } from '../src/pools.ts';
import { conveyorPick, inProgress } from '../src/conveyor.ts';
import { DecisionLog, extractFacts, fixKey } from '../src/decisions.ts';
import { TaskGraph } from '../src/graph.ts';
import { importClaimFalse, scopeClaimFalse } from '../src/pipeline.ts';
import { Stats } from '../src/stats.ts';
import { loadCatalog } from '../src/catalog.ts';
import type { CatalogModel, PlannedTask, Task, Team } from '../src/types.ts';
import type { WorkItem } from '../src/dispatcher.ts';

const LIST = 'src/pages/*-list/ui/*ListPage.tsx';
const EX = 'src/pages/address-list/ui/AddressListPage.tsx';

function webPage(entity: string): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'ay-alg-')), 'web');
  createWebRepo(dir);
  const P = entity[0]!.toUpperCase() + entity.slice(1);
  return readFileSync(path.join(dir, `src/pages/${entity}-list/ui/${P}ListPage.tsx`), 'utf8');
}

/** Как модель переписывает таблицу на Mantine (неважно — фрагментами или файлом целиком). */
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

test('общее решение: правила из образца воспроизводят его и встают в другой файл шаблона', () => {
  const before = webPage('address');
  const after = toMantine(before);
  const rules = learnRules(before, after);
  assert.equal(rules.exact, true, 'правила, применённые к старому образцу, дают новый');
  assert.ok(rules.lacks.includes('<table') && rules.lacks.includes('af-table'), 'признаки старого — теги и класс');
  assert.ok(rules.has.some((h) => h.includes("import { Table } from '@mantine/core'")));

  const user = webPage('user');
  const pairs = entityPairs(LIST, EX, 'src/pages/user-list/ui/UserListPage.tsx');
  const o = applyRules(user, rules, pairs);
  assert.ok(fits(o), JSON.stringify({ left: o.leftovers, unmet: o.unmet }));
  assert.equal(o.text, toMantine(user), 'та же правка, что сделала бы модель');

  // файл, где есть вариант, которого не было в образце (<td className="num">), программе не подходит —
  // уходит модели, а шаги говорят, что именно осталось
  const odd = user.replace('<td>{String(row.created_at)}</td>', '<td className="num">{String(row.created_at)}</td>');
  const o2 = applyRules(odd, rules, pairs);
  assert.equal(fits(o2), false);
  assert.deepEqual(o2.leftovers, ['<td']);
  const steps = rulesSteps(rules, 'src/pages/user-list/ui/UserListPage.tsx', pairs, o2.leftovers);
  assert.match(steps.join('\n'), /import \{ Table \} from '@mantine\/core'/);
  assert.match(steps.join('\n'), /`<table className="af-table">` замени на `<Table striped highlightOnHover withTableBorder>`/);
  assert.match(steps.at(-1)!, /не должно остаться/);
  const dw = rulesDoneWhen(rules, 'x.tsx', pairs);
  assert.ok(dw.lacks.includes('<td'));

  // в файле без таблицы менять нечего — импорт туда не добавляется
  const o3 = applyRules("export function X() {\n  return <div>пусто</div>\n}\n", rules, []);
  assert.equal(o3.nothingToDo, true);
  assert.equal(o3.changed, false);
});

test('общее решение: файл целиком (search пустой) — правила всё равно выводятся из текста до и после', () => {
  const before = webPage('order');
  const rules = learnRules(before, toMantine(before));
  assert.equal(rules.exact, true);
  assert.ok(rules.subs.length >= 8);
});

test('классификатор: шаблон пути — одно имя сущности во всех частях пути', () => {
  assert.deepEqual(fileTemplate(EX, 'src/pages/audit-log-list/ui/AuditLogListPage.tsx'), { glob: 'src/pages/*-list/ui/*ListPage.tsx', core: ['address', 'audit-log'] });
  assert.equal(fileTemplate(EX, 'src/pages/user-edit/ui/UserEditPage.tsx'), null, 'list и edit — разные виды страниц');
  assert.equal(fileTemplate('src/a/one.ts', 'src/b/two.ts'), null, 'разные имена в разных частях пути — не шаблон');
  assert.equal(fileTemplate(EX, EX), null);
});

const T = (id: string, title: string, files: string[], extra: Partial<Task> = {}): Task => ({
  id,
  type: 'edit',
  title,
  brief: title,
  dependsOn: [],
  files,
  accept: { tests: [], commands: [] },
  size: 'S',
  role: 'coder',
  status: 'ready',
  weight: 1,
  attempts: 0,
  ladderStep: 0,
  failures: [],
  readySince: 0,
  frozenFiles: [],
  ...extra,
});

test('классификатор: одинаковые задачи на однотипных файлах — один пул, первый — образец', () => {
  const tasks = [
    T('T1', 'Подключить MantineProvider в layout', ['app/layout.tsx'], { seq: '0001' }),
    T('T2', 'Обернуть таблицу адресов в Mantine Table', [EX], { seq: '0002' }),
    T('T3', 'Обернуть таблицу заказов в Mantine Table', ['src/pages/order-list/ui/OrderListPage.tsx'], { seq: '0003' }),
    T('T4', 'Обернуть таблицу пользователей в Mantine Table', ['src/pages/user-list/ui/UserListPage.tsx'], { seq: '0004' }),
    T('T5', 'Добавить валидацию формы заказа', ['src/pages/order-edit/ui/OrderEditPage.tsx'], { seq: '0005' }),
    T('T6', 'Обернуть таблицу товаров в Mantine Table', ['src/pages/product-list/ui/ProductListPage.tsx'], { seq: '0006', dependsOn: ['T2'] }),
  ];
  const pools = classify(tasks);
  assert.equal(pools.length, 1);
  assert.equal(pools[0]!.leader, 'T2');
  assert.deepEqual(pools[0]!.members, ['T2', 'T3', 'T4'], 'T6 зависит от T2 — это цепочка, не повтор; T5 — другая работа');
  assert.equal(pools[0]!.glob, LIST);
  // начатая задача в пул не попадает
  assert.equal(classify([tasks[1]!, { ...tasks[2]!, attempts: 1 }]).length, 0);
});

function team(): { team: Team; a: CatalogModel; b: CatalogModel } {
  const cat = loadCatalog();
  const a = { ...cat.find((m) => m.ollamaTag.startsWith('qwen3.6'))! };
  const b = { ...cat.find((m) => m.ollamaTag.startsWith('gpt-oss'))! };
  return { team: { models: [a, b], byRole: { coder: a, reviewer: b, planner: a, analyst: a, tester: a, scout: a, reporter: a }, score: 1 }, a, b };
}

test('конвейер: начатое — раньше нового; в обычном режиме не больше WIP, сверх — только чтобы не менять модель', () => {
  const { team: tm, a } = team();
  const ctx = { team: tm, stats: new Stats(null), loadedModelId: a.id, now: 0, fits: () => true };
  const t1 = T('T1', 'a', ['a.ts'], { seq: '0001' });
  const t2 = T('T2', 'b', ['b.ts'], { seq: '0002', attempts: 1, workdir: '/tmp/x' }); // переделка
  const t3 = T('T3', 'c', ['c.ts'], { seq: '0003' });
  const items: WorkItem[] = [t1, t2, t3].map((t) => ({ task: t, role: 'coder', kind: 'work' }));
  let r = conveyorPick(items, [t1, t2, t3], ctx);
  assert.equal(r.pick?.item.task.id, 'T2', 'переделка начатой задачи — первой');
  assert.match(r.pick!.reason, /^эпоха \S+: доделываю начатую/);

  // в работе уже 3 (WIP), всё на проверках — загруженная модель берёт ещё независимую задачу, а не ждёт и не меняется
  const busy = [T('B1', 'x', ['x'], { status: 'checking', workdir: '/w', seq: '0010' }), T('B2', 'y', ['y'], { status: 'checking', workdir: '/w', seq: '0011' }), T('B3', 'z', ['z'], { status: 'checking', workdir: '/w', seq: '0012' })];
  const all = [...busy, t1, t3];
  assert.equal(inProgress(all), 3);
  r = conveyorPick([{ task: t1, role: 'coder', kind: 'work' }, { task: t3, role: 'coder', kind: 'work' }], all, ctx, { checking: true });
  assert.equal(r.pick?.item.task.id, 'T1');
  assert.match(r.pick!.reason, /беру ещё независимую задачу вместо смены модели \(в работе 3 из 6\)/);
  // предел эпохи (6) — ждём проверок
  const full = [...busy, ...[4, 5, 6].map((n) => T(`B${n}`, 'w', [`w${n}`], { status: 'checking', workdir: '/w', seq: `00${20 + n}` }))];
  r = conveyorPick([{ task: t1, role: 'coder', kind: 'work' }], [...full, t1], ctx, { checking: true });
  assert.equal(r.pick, null);
  assert.equal(r.wait, true);
});

test('конвейер: ревью — та же модель для маленькой проверенной правки, другая — для важной, пачкой', () => {
  const { team: tm, a, b } = team();
  const ctx = { team: tm, stats: new Stats(null), loadedModelId: a.id, now: 0, fits: () => true };
  const small = T('S1', 'мелочь', ['a.ts'], { status: 'review', workdir: '/w', doneBy: a.id, seq: '0001' });
  const big = T('M1', 'крупнее', ['b.ts', 'c.ts'], { status: 'review', workdir: '/w', doneBy: a.id, seq: '0002', size: 'M' });
  const big2 = T('M2', 'крупнее', ['d.ts'], { status: 'review', workdir: '/w', doneBy: a.id, seq: '0003', size: 'M' });
  const t9 = T('T9', 'новая', ['z.ts'], { seq: '0009' });
  const rv = (t: Task): WorkItem => ({ task: t, role: 'reviewer', kind: 'review' });
  let r = conveyorPick([rv(small), rv(big), rv(big2), { task: t9, role: 'coder', kind: 'work' }], [small, big, big2, t9], ctx);
  assert.equal(r.pick?.item.task.id, 'S1');
  assert.equal(r.pick?.model.id, a.id);
  assert.match(r.pick!.reason, /ревью той же моделью: маленькая правка/);
  // важные ревью копятся: загруженная модель кодит дальше
  r = conveyorPick([rv(big), rv(big2), { task: t9, role: 'coder', kind: 'work' }], [big, big2, t9], ctx);
  assert.equal(r.pick?.item.task.id, 'T9');
  // кодить нечего, проверок нет — смена модели, и она делает все ревью подряд
  r = conveyorPick([rv(big), rv(big2)], [big, big2], ctx);
  assert.equal(r.pick?.model.id, b.id);
  assert.match(r.pick!.reason, /смена модели на gpt-oss:20b: у неё 2 шаг\(ов\) работы/);
  r = conveyorPick([rv(big2)], [big2], { ...ctx, loadedModelId: b.id });
  assert.match(r.pick!.reason, /эпоха gpt-oss:20b: ревью, пока нужная модель в памяти/);
  // проверки ещё идут — не меняем модель, ждём (после них работа для загруженной может появиться)
  r = conveyorPick([rv(big)], [big], ctx, { checking: true });
  assert.equal(r.pick, null);
  assert.equal(r.wait, true);
});

test('конвейер: слабая модель не держит задачу только потому, что загружена — считается время до успеха с долей смены', () => {
  const cat = loadCatalog();
  const weak = { ...cat.find((m) => m.ollamaTag === 'qwen3.5:4b')! };
  const strong = { ...cat.find((m) => m.ollamaTag.startsWith('gpt-oss'))! };
  const tm: Team = { models: [weak, strong], byRole: { coder: strong, reviewer: strong, planner: strong, analyst: strong, tester: strong, scout: weak, reporter: weak }, score: 1 };
  const ctx = { team: tm, stats: new Stats(null), loadedModelId: weak.id, now: 0, fits: () => true };
  const items: WorkItem[] = ['T1', 'T2', 'T3'].map((id, i) => ({ task: T(id, 'правка', [`${id}.ts`], { seq: `000${i + 1}` }), role: 'coder', kind: 'work' }));
  const r = conveyorPick(items, items.map((i) => i.task), ctx);
  assert.equal(r.pick?.model.id, strong.id);
  assert.match(r.pick!.reason, /смена модели на gpt-oss:20b: у неё 3 шаг\(ов\) работы/);
  assert.match(r.pick!.reason, /до успеха ≈\d+ с/);
});

test('конвейер: ревью образца, которого ждут другие, — сразу после начатой работы, даже со сменой модели', () => {
  const { team: tm, a, b } = team();
  const ctx = { team: tm, stats: new Stats(null), loadedModelId: a.id, now: 0, fits: () => true };
  const lead = T('T2', 'образец', [EX], { status: 'review', workdir: '/w', doneBy: a.id, seq: '0002' });
  const t9 = T('T9', 'другое', ['z.ts'], { seq: '0009' });
  const r = conveyorPick([{ task: lead, role: 'reviewer', kind: 'review' }, { task: t9, role: 'coder', kind: 'work' }], [lead, t9], ctx, { blocks: (t) => (t.id === 'T2' ? 5 : 0), isLeader: (t) => t.id === 'T2' });
  assert.equal(r.pick?.item.task.id, 'T2');
  assert.equal(r.pick?.model.id, b.id);
});

test('журнал решений: факты из diff, контекст — предкам, соседям и пулу', () => {
  const before = webPage('address');
  const facts = extractFacts([{ file: EX, before, after: toMantine(before) }, { file: 'src/ui/Wrap.tsx', before: null, after: "'use client'\nexport function Wrap() { return null }\n" }], { installed: ['@mantine/core@9.7.3'] });
  const text = facts.join('\n');
  assert.match(text, /импорт `import \{ Table \} from '@mantine\/core'`/);
  assert.match(text, /создан src\/ui\/Wrap\.tsx \(экспорт: Wrap\)/);
  assert.match(text, /больше нет <table>/);
  assert.match(text, /убраны классы af-table/);
  assert.match(text, /поставлены пакеты @mantine\/core@9\.7\.3/);

  const plan: PlannedTask[] = [
    { id: 'T1', type: 'edit', title: 'Провайдер', brief: '', dependsOn: [], files: ['app/layout.tsx'], accept: { tests: [], commands: [] }, size: 'S' },
    { id: 'T2', type: 'edit', title: 'Таблицы', brief: '', dependsOn: ['T1'], files: [EX], accept: { tests: [], commands: [] }, size: 'M' },
    { id: 'T9', type: 'edit', title: 'Прочее', brief: '', dependsOn: [], files: ['README.md'], accept: { tests: [], commands: [] }, size: 'S' },
  ];
  const g = new TaskGraph(plan);
  g.split('T2', [
    { id: 'T2.1', type: 'edit', title: 'Импорт', brief: '', dependsOn: [], files: [EX], accept: { tests: [], commands: [] }, size: 'S' },
    { id: 'T2.2', type: 'edit', title: 'Теги', brief: '', dependsOn: ['T2.1'], files: [EX], accept: { tests: [], commands: [] }, size: 'S' },
  ]);
  const log = new DecisionLog();
  log.add({ taskId: 'T1', title: 'Провайдер', facts: ['MantineProvider в app/layout.tsx'], files: ['app/layout.tsx'] });
  log.add({ taskId: 'T2.1', title: 'Импорт', facts: ['импорт Table'], files: [EX], parent: 'T2' });
  log.add({ taskId: 'T9', title: 'Прочее', facts: ['README'], files: ['README.md'] });
  const rel = log.relevant(g.get('T2.2'), g.tasks).map((d) => d.taskId);
  assert.deepEqual(rel.sort(), ['T1', 'T2.1'], 'соседняя часть и зависимость родителя — да, чужая задача — нет');
  assert.match(DecisionLog.render(log.relevant(g.get('T2.2'), g.tasks)), /T2\.1 «Импорт»: импорт Table/);
  // «как починили» находится по подписи ошибки без путей и чисел
  assert.equal(fixKey("5:typecheck:src/a/A.tsx(3,7): TS2304 Cannot find name 'Table'"), fixKey("5:typecheck:src/b/B.tsx(9,1): TS2304 Cannot find name 'Table'"));
});

test('ревью: «нет импорта Table» при импорте в файле и «другие страницы не изменены» в задаче-части — снимаются', () => {
  const file = { file: EX, text: toMantine(webPage('address')) };
  assert.ok(importClaimFalse('В файле заменены HTML-теги на компоненты Mantine Table, но отсутствует импорт компонента `Table`.', [file], true));
  assert.equal(importClaimFalse('Нет импорта компонента `Badge`', [file], true), null, 'Badge не используется — судить нечего');
  assert.equal(importClaimFalse('отсутствует импорт `Table`', [{ file: EX, text: '<Table></Table>' }], true), null, 'импорта действительно нет');
  const part = T('T2.p7', 'Таблицы: RoleListPage', ['src/pages/role-list/ui/RoleListPage.tsx'], { pool: 'T2' });
  assert.ok(scopeClaimFalse('Only role-list was updated; other list pages (e.g., address-list, order-list) still use plain <table> tags.', part));
  assert.equal(scopeClaimFalse('В RoleListPage.tsx не закрыт тег </Table.Tr>', part), null, 'причина про свой файл остаётся');
});

test('общее решение: обёртка блока, атрибут в теге, похожая-но-другая строка', () => {
  const before = webPage('address');
  const order = webPage('order');
  const pairs = entityPairs(LIST, EX, 'src/pages/order-list/ui/OrderListPage.tsx');
  // обёртка: строки вставляются после своих соседей (а не «где-нибудь»), закрывающий тег — тоже
  const wrap = (s: string) => s.replace('        <table className="af-table">', '        <div className="table-wrap">\n          <table className="af-table">').replace('        </table>\n', '          </table>\n        </div>\n');
  const rw = learnRules(before, wrap(before));
  assert.equal(rw.exact, true);
  const ow = applyRules(order, rw, pairs);
  assert.ok(fits(ow));
  assert.match(ow.text, /<div className="table-wrap">\n\s*<table className="af-table">/);
  assert.match(ow.text, /<\/table>\n\s*<\/div>/);
  // атрибут в теге с русским текстом внутри: правило по тегу, а не по строке с «Адреса»
  const title = (s: string) => s.replace(/<h1>(.*?)<\/h1>/, '<h1 className="title">$1</h1>');
  const rt = learnRules(before, title(before));
  assert.deepEqual(rt.subs, [{ from: '<h1>', to: '<h1 className="title">' }]);
  assert.equal(applyRules(order, rt, pairs).text, title(order));
  // замена целой строки, а в файле строка чуть другая — не «менять нечего», а к модели
  const cls = (s: string) => s.replace('className="af-btn primary"', 'className="btn btn-primary"');
  const rc = learnRules(before, cls(before));
  const odd = order.replace('href="/orders/new">', 'href="/orders/new" title="x">');
  const oc = applyRules(odd, rc, pairs);
  assert.equal(fits(oc), false);
  assert.equal(oc.nothingToDo, false);
  assert.match(oc.unmet[0]!, /похожая на <Link className="af-btn primary" href="\/orders\/new">/);
});

test('файл целиком: в лимит идут изменённые строки, а не длина файла', async () => {
  const { changedLineCount } = await import('../src/tools/patch.ts');
  const before = webPage('address');
  assert.equal(changedLineCount(before, before), 0);
  const n = changedLineCount(before, toMantine(before));
  assert.ok(n > 5 && n < 25, String(n));
});

test('общее решение: блок 6 строк → 4 (шапка) — свои заголовок и адрес страницы переносятся, лишние </div> не трогаются', () => {
  const before = webPage('address');
  const head = (s: string) =>
    s.replace(/      <div className="af-head">\n        <h1>(.*?)<\/h1>\n        <Link className="af-btn primary" href="(.*?)">\n          Добавить\n        <\/Link>\n      <\/div>\n/, `      <h1 style={{ fontSize: '24px' }}>$1</h1>\n      <Link href="$2" style={{ padding: '8px 16px' }}>\n        Добавить\n      </Link>\n`);
  assert.notEqual(head(before), before);
  const rules = learnRules(before, head(before));
  assert.equal(rules.exact, true);
  assert.equal(rules.blocks?.length, 1);
  assert.deepEqual(rules.removes, [], 'никаких глобальных удалений «</div>»');
  for (const e of ['user', 'order', 'review']) {
    const t = webPage(e);
    const o = applyRules(t, rules, entityPairs(LIST, EX, `src/pages/${e}-list/ui/${e[0]!.toUpperCase()}${e.slice(1)}ListPage.tsx`));
    assert.ok(fits(o), e);
    assert.equal(o.text, head(t), e);
  }
});
