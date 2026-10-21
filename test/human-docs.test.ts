// Подсказка человека по «на чём споткнулись», задачи не про код (документы, данные), варианты правки, склейка дублей.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { chunkText, extractText, htmlToText, unzip } from '../src/engine/extract.ts';
import { describeStumble, errorsWithPlace } from '../src/engine/stumble.ts';
import { mergeDuplicates, validatePlan } from '../src/plan.ts';
import { createWebRepo } from '../src/demo.ts';
import { MockRuntime } from '../src/runtime/mock.ts';
import { Pipeline } from '../src/pipeline.ts';
import { loadCatalog } from '../src/catalog.ts';
import { Stats } from '../src/stats.ts';
import { dataFileProblem } from '../src/checks.ts';
import type { ChatMessage, ChatRequest } from '../src/runtime/types.ts';
import type { Hardware, PlannedTask, Task } from '../src/types.ts';

const HW: Hardware = { gpuName: 'test', vramTotalGb: 16, vramFreeGb: 16, ramTotalGb: 32, ramFreeGb: 24, cpuCores: 8, unifiedMemory: false, tier: 'T2' };
const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
const tmp = () => mkdtempSync(path.join(tmpdir(), 'ay-hd-'));
const userText = (req: ChatRequest) => req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');

/** Минимальный zip (deflate) — как docx/xlsx. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const data = deflateRawSync(raw);
    const n = Buffer.from(name);
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data);
    central.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const docx = (paras: string[]) => zip({ 'word/document.xml': `<?xml version="1.0"?><w:document><w:body>${paras.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>` });

test('документы: docx, xlsx, html и простой pdf читаются без внешних библиотек; большой текст режется по абзацам', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'd.docx'), docx(['Договор поставки № 17', 'Срок оплаты — 10 дней.']));
  assert.deepEqual(extractText(path.join(dir, 'd.docx'))!.text.split('\n'), ['Договор поставки № 17', 'Срок оплаты — 10 дней.']);
  writeFileSync(path.join(dir, 't.xlsx'), zip({
    'xl/sharedStrings.xml': '<sst><si><t>Заказ</t></si><si><t>Сумма</t></si><si><t>A-1</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1500</v></c></row></sheetData></worksheet>',
  }));
  assert.match(extractText(path.join(dir, 't.xlsx'))!.text, /Заказ;Сумма\nA-1;1500/);
  assert.equal(htmlToText('<html><style>p{}</style><body><h1>Итог</h1><p>Цена&nbsp;&mdash; 5&nbsp;₽</p></body></html>'), 'Итог\nЦена — 5 ₽');
  writeFileSync(path.join(dir, 'p.pdf'), '%PDF-1.4\n1 0 obj << /Length 60 >>\nstream\nBT /F1 12 Tf (Hello world, invoice number 42 total 100 EUR) Tj ET\nendstream\nendobj\n%%EOF');
  assert.match(extractText(path.join(dir, 'p.pdf'))!.text, /invoice number 42/);
  assert.equal(unzip(docx(['x'])).size, 1);
  const parts = chunkText(Array.from({ length: 30 }, (_, i) => `Абзац ${i} ${'текст '.repeat(40)}`).join('\n\n'), 1000);
  assert.ok(parts.length > 5 && parts.every((p) => p.length <= 1000), String(parts.map((p) => p.length)));
  // результат-данные: пустой файл и кривой CSV — понятные ошибки
  writeFileSync(path.join(dir, 'e.md'), '  \n');
  assert.match(dataFileProblem('out/e.md', path.join(dir, 'e.md'), true)!, /пустой/);
  writeFileSync(path.join(dir, 'c.csv'), 'id;name;sum\n1;Иван;100\n2;Пётр\n');
  assert.match(dataFileProblem('out/c.csv', path.join(dir, 'c.csv'), true)!, /3 колонок, а в строках 3 — 2/);
});

test('на чём споткнулись: ступень, ошибка с местом, что пробовали, что нужно от человека', () => {
  const err = "Ступень 5 (типы):\nНовые ошибки (бывшие до прогона не считаются: 2):\nsrc/features/audit-log-form/ui/AuditLogForm.tsx(32,82): error TS2322: Type 'Resolver<A>' is not assignable to type 'Resolver<B>'.";
  assert.deepEqual(errorsWithPlace(err), [{ where: 'src/features/audit-log-form/ui/AuditLogForm.tsx:32', text: "TS2322: Type 'Resolver<A>' is not assignable to type 'Resolver<B>'." }]);
  const t = { id: 'T1', title: 'x', brief: '', type: 'edit', dependsOn: [], files: [], accept: { tests: [], commands: [] }, size: 'S', role: 'coder', status: 'human', weight: 1, attempts: 2, ladderStep: 3, failures: ['5:typecheck:x'], readySince: 0, frozenFiles: [], lastError: err, attemptLog: [{ sig: '5:typecheck:x', cls: 'own', stage: 5, errors: 1, model: 'qwen3.6' }, { sig: '5:typecheck:x', cls: 'own', stage: 5, errors: 1, model: 'gpt-oss:20b' }] } as unknown as Task;
  const st = describeStumble(t)!;
  assert.equal(st.stage, 'Проверка типов');
  assert.match(st.summary, /AuditLogForm\.tsx:32 — TS2322/);
  assert.equal(st.tried.length, 2);
  assert.match(st.need, /Как исправить ошибку в AuditLogForm\.tsx:32\?/);
});

test('план: одинаковые задачи склеиваются, одинаковая правка в разных файлах — нет; задача про документ не требует теста', () => {
  const t = (o: Partial<PlannedTask> & { id: string }): PlannedTask => ({ type: 'edit', title: o.id, brief: '', dependsOn: [], files: [], accept: { tests: [], commands: [] }, size: 'S', ...o });
  const w: string[] = [];
  const r = mergeDuplicates({ goal: 'x', tasks: [
    t({ id: 'T1', title: 'Подключить MantineProvider в layout', files: ['app/layout.tsx'], stage: 'Подключить кит' }),
    t({ id: 'T2', title: 'Подключение MantineProvider к layout', files: ['app/layout.tsx'] }),
    t({ id: 'T3', title: 'Заменить таблицу', files: ['a.tsx'] }),
    t({ id: 'T4', title: 'Заменить таблицу', files: ['b.tsx'] }),
    t({ id: 'T5', title: 'Шапка кнопками', files: ['nav.tsx'], dependsOn: ['T2'] }),
  ] }, w);
  assert.deepEqual(r.tasks.map((x) => x.id), ['T1', 'T3', 'T4', 'T5']);
  assert.deepEqual(r.tasks[3]!.dependsOn, ['T1']);
  assert.match(w[0]!, /T2 → T1/);
  // папка с документом, в проекте есть тесты — но задаче про документ критерий не нужен
  const repo = path.join(tmp(), 'web');
  createWebRepo(repo);
  writeFileSync(path.join(repo, 'договор.docx'), docx(['x']));
  const plan = validatePlan({ goal: 'x', tasks: [t({ id: 'D1', title: 'Краткое содержание договора', inputs: ['договор.docx'], files: ['out/summary.md'], newFiles: ['out/summary.md'] })] }, repo, 'T2', { test: 'npm test', testFiles: null, lint: null, typecheck: null });
  assert.equal(plan.ok, true, plan.errors.join('\n'));
  const missing = validatePlan({ goal: 'x', tasks: [t({ id: 'D1', title: 'x', inputs: ['нет.docx'], files: ['out/a.md'], newFiles: ['out/a.md'] })] }, repo, 'T2');
  assert.match(missing.errors.join('\n'), /исходного файла нет\.docx нет в папке/);
});

function docsFolder(): string {
  const dir = path.join(tmp(), 'Документы');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'договор.docx'), docx(['Договор поставки № 17 между ООО «Ромашка» и ИП Петров.', 'Поставка до 1 декабря 2026 года.', 'Оплата в течение 10 банковских дней, штраф 0,1% в день.']));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base'], { cwd: dir });
  return dir;
}

test('задача не про код: краткое содержание docx в папке без кода — исполнитель видит текст документа, результат в out/', async () => {
  const repo = docsFolder();
  let sawText = false;
  const plan = [{ id: 'T1', type: 'edit', title: 'Краткое содержание договора', stage: 'Краткое содержание', brief: 'Сделай краткое содержание: стороны, сроки, оплата.', dependsOn: [], inputs: ['договор.docx'], files: ['out/summary.md'], newFiles: ['out/summary.md'], accept: { tests: [], commands: [] }, size: 'S' }];
  const rt = new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], (req) => {
    const system = req.messages[0]?.content ?? '';
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('планировщик')) return json({ understanding: 'краткое содержание договора', tasks: plan });
    sawText ||= /## Исходные материалы[\s\S]*Оплата в течение 10 банковских дней/.test(userText(req));
    return json({ patches: [{ file: 'out/summary.md', search: '', replace: '# Договор № 17\n\n- Стороны: ООО «Ромашка» и ИП Петров\n- Поставка до 1 декабря 2026\n- Оплата 10 банковских дней, штраф 0,1% в день\n' }], note: 'краткое содержание' });
  });
  const r = await new Pipeline({ repo, goal: 'сделай краткое содержание договор.docx', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, autoApply: true }).run();
  const journal = readFileSync(path.join(r.runDir, 'journal.txt'), 'utf8');
  assert.ok(sawText, 'текст docx в запросе исполнителя');
  assert.deepEqual(r.done, ['T1'], journal);
  assert.equal(r.applied?.ok, true, r.applied?.message ?? "");
  assert.match(readFileSync(path.join(repo, 'out/summary.md'), 'utf8'), /Поставка до 1 декабря 2026/);
});

test('большой документ: программа режет на части (выжимки), последняя часть собирает итог', async () => {
  const repo = docsFolder();
  writeFileSync(path.join(repo, 'отчёт.txt'), Array.from({ length: 24 }, (_, i) => `Раздел ${i + 1}. ${'Подробности раздела. '.repeat(30)}`).join('\n\n'));
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'report'], { cwd: repo });
  const plan = [{ id: 'T1', type: 'edit', title: 'Краткое содержание отчёта', brief: 'Перечисли разделы отчёта.', dependsOn: [], inputs: ['отчёт.txt'], files: ['out/summary.md'], newFiles: ['out/summary.md'], accept: { tests: [], commands: [] }, size: 'S' }];
  const rt = new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], (req) => {
    const system = req.messages[0]?.content ?? '';
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('планировщик')) return json({ understanding: 'x', tasks: plan });
    const u = userText(req);
    const out = /Запиши в (out\/\.parts\/\S+\.md)/.exec(u)?.[1];
    if (out) return json({ patches: [{ file: out, search: '', replace: `- ${[...u.matchAll(/Раздел (\d+)\./g)].map((m) => m[1]).join(', ')}\n` }], note: 'выжимка' });
    return json({ patches: [{ file: 'out/summary.md', search: '', replace: '# Отчёт\nРазделы 1–24.\n' }], note: 'итог' });
  });
  const r = await new Pipeline({ repo, goal: 'перескажи отчёт', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, numCtx: 4096 }).run();
  const journal = readFileSync(path.join(r.runDir, 'journal.txt'), 'utf8');
  assert.match(journal, /режу на \d+ частей/);
  assert.ok(r.done.includes('T1'), journal);
  assert.ok(r.done.filter((x) => x.startsWith('T1.')).length >= 3, r.done.join(','));
  assert.deepEqual(r.human, [], journal);
});

const PAGE = 'src/pages/address-list/ui/AddressListPage.tsx';

/** Сайт с проверкой «в странице есть текст» — команда критерия задачи. */
function webWithCheck(need: string): string {
  const repo = path.join(tmp(), 'web');
  createWebRepo(repo);
  writeFileSync(path.join(repo, 'check.mjs'), `import { readFileSync } from 'node:fs';\nif (!readFileSync(${JSON.stringify(PAGE)}, 'utf8').includes(${JSON.stringify(need)})) { console.error('error: в странице нет ${need}'); process.exit(1); }\n`);
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'check'], { cwd: repo });
  return repo;
}

test('подсказка человека: задача застряла, человек вставил решение — исполнитель получает его и задача проходит', async () => {
  const repo = webWithCheck('Адреса доставки');
  const plan = [{ id: 'T1', type: 'edit', title: 'Заголовок страницы адресов', brief: 'Поменять заголовок', dependsOn: [], files: [PAGE], accept: { tests: [], commands: ['node check.mjs'] }, size: 'S' }];
  let hinted = false;
  const rt = () => new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], (req) => {
    const system = req.messages[0]?.content ?? '';
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('планировщик')) return json({ understanding: 'x', tasks: plan });
    if (system.includes('аналитик')) return json({ brief: 'поменять заголовок', files: [PAGE] });
    const u = userText(req);
    if (/## Подсказка человека[\s\S]*Адреса доставки/.test(u)) {
      hinted = true;
      return json({ patches: [{ file: PAGE, search: '<h1>', replace: '<h1 title="Адреса доставки">' }], note: 'по подсказке' });
    }
    return json({ patches: [{ file: PAGE, search: '<h1>', replace: '<h1 className="x">' }], note: 'наугад' });
  });
  const opts = { repo, goal: 'заголовок', catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, runId: 'h1', sampling: 1 };
  const first = await new Pipeline({ ...opts, runtime: rt() }).run();
  assert.ok(first.human.some((h) => h.id === 'T1'), JSON.stringify(first.human));
  const st = JSON.parse(readFileSync(path.join(first.runDir, 'state.json'), 'utf8'));
  assert.ok(st.tasks.some((x: Task) => (x.attemptLog?.length ?? 0) >= 2), 'история попыток сохранена — из неё строится «на чём споткнулись»');
  const r = await new Pipeline({ ...opts, runtime: rt(), resume: true, humanHints: { T1: 'Добавь в заголовок текст «Адреса доставки» (можно атрибутом title).' } }).run();
  const journal = readFileSync(path.join(r.runDir, 'journal.txt'), 'utf8');
  assert.ok(hinted, 'подсказка дошла до исполнителя');
  assert.ok(r.done.includes('T1'), journal);
  assert.deepEqual(r.human, [], journal);
  assert.match(journal, /человек подсказал решение/);
});

test('варианты правки: после своей ошибки модель даёт ещё ответы с другой температурой, программа берёт прошедший проверки', async () => {
  const repo = webWithCheck('data-ok');
  const plan = [{ id: 'T1', type: 'edit', title: 'Заголовок', brief: 'Заголовок', dependsOn: [], files: [PAGE], accept: { tests: [], commands: ['node check.mjs'] }, size: 'S' }];
  const temps: (number | undefined)[] = [];
  const rt = new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], (req) => {
    const system = req.messages[0]?.content ?? '';
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('планировщик')) return json({ understanding: 'x', tasks: plan });
    temps.push(req.temperature);
    // смелый ответ (температура выше) — верный
    return (req.temperature ?? 0) > 0.5
      ? json({ patches: [{ file: PAGE, search: '<h1>', replace: '<h1 data-ok>' }], note: 'вариант' })
      : json({ patches: [{ file: PAGE, search: '<h1>', replace: '<h1 className="x">' }], note: 'осторожно' });
  });
  const r = await new Pipeline({ repo, goal: 'заголовок', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, sampling: 3 }).run();
  const journal = readFileSync(path.join(r.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(r.done, ['T1'], journal);
  assert.match(journal, /из \d вариантов правки проверки прошёл 2-й/);
  assert.ok(temps.some((x) => (x ?? 0) > 0.5), JSON.stringify(temps));
  assert.ok(!existsSync(path.join(repo, 'out')));
});
