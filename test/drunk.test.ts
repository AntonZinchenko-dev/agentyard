// «Пьяный тест»: небрежная цель → нужный результат прямо в папке проекта, без второго захода.
// Модели здесь учебные, но ведут себя как настоящие маленькие: первый план промахивается мимо общего CSS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MockRuntime } from '../src/runtime/mock.ts';
import { Pipeline } from '../src/pipeline.ts';
import { loadCatalog } from '../src/catalog.ts';
import { Stats } from '../src/stats.ts';
import type { ChatMessage, ChatRequest } from '../src/runtime/types.ts';
import type { Hardware } from '../src/types.ts';

const HW: Hardware = { gpuName: 'test', vramTotalGb: 48, vramFreeGb: 48, ramTotalGb: 64, ramFreeGb: 32, cpuCores: 8, unifiedMemory: false, tier: 'T3' };
const CSS = '.af-btn { padding: 7px 14px; background: #fff; }\n.af-btn.primary { background: #2f6fdb; border-color: #2f6fdb; color: #fff; }\n';
const PAGE = 'export function AddressListPage() {\n  return <a className="af-btn primary" href="/addresses/new">Добавить</a>\n}\n';

function makeWeb(): string {
  const root = path.join(mkdtempSync(path.join(tmpdir(), 'ay-drunk-')), 'web');
  const w = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  w('package.json', '{"name":"web","private":true}');
  w('src/shared/ui/generated.css', CSS);
  w('src/pages/address-list/ui/AddressListPage.tsx', PAGE);
  w('src/pages/user-list/ui/UserListPage.tsx', PAGE.replace(/Address/g, 'User').replace('addresses', 'users'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: root });
  return root;
}

test('«сделай кнопки красными бля»: промах первого плана ловит приёмка, доделка, результат сразу в проекте', async () => {
  const root = makeWeb();
  const seen = { plannerPrompt: '', goalChecks: 0 };
  const script = (req: ChatRequest): ChatMessage => {
    const system = req.messages[0]?.content ?? '';
    const user = req.messages[1]?.content ?? '';
    const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
    if (system.includes('планировщик')) {
      seen.plannerPrompt = user;
      // типичный промах маленькой модели: красит одну страницу инлайн-стилем
      return json({
        understanding: 'Кнопка «Добавить» на странице адресов должна стать красной.',
        tasks: [{ id: 'T1', type: 'edit', title: 'Красная кнопка', brief: 'Добавь style={{background:"red"}} кнопке', dependsOn: [], files: ['src/pages/address-list/ui/AddressListPage.tsx'], accept: { tests: [], commands: [] }, size: 'S' }],
      });
    }
    if (system.includes('приёмщик')) {
      seen.goalChecks += 1;
      const from = user.indexOf('## Итоговые изменения');
      const diff = user.slice(from, user.indexOf('\n## ', from + 5));
      if (diff.includes('generated.css')) return json({ achieved: true, missing: [], tasks: [] });
      return json({
        achieved: false,
        missing: ['покрашена одна кнопка на одной странице, а просили кнопки (на всех страницах)'],
        tasks: [{ id: '1', type: 'edit', title: 'Красные кнопки в общем CSS', brief: 'В .af-btn.primary поставь background и border-color #d32f2f', dependsOn: [], files: ['src/shared/ui/generated.css'], accept: { tests: [], commands: [] }, size: 'S' }],
      });
    }
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('кодер')) {
      // упрямая маленькая модель: общий CSS ей показан, но правит она его, только если бриф прямо об этом
      if (user.includes('## Файл src/shared/ui/generated.css') && user.includes('.af-btn.primary поставь')) {
        return json({ patches: [{ file: 'src/shared/ui/generated.css', search: '.af-btn.primary { background: #2f6fdb; border-color: #2f6fdb; color: #fff; }', replace: '.af-btn.primary { background: #d32f2f; border-color: #d32f2f; color: #fff; }' }], note: 'красные кнопки' });
      }
      return json({ patches: [{ file: 'src/pages/address-list/ui/AddressListPage.tsx', search: '<a className="af-btn primary"', replace: '<a style={{ background: "red" }} className="af-btn primary"' }], note: 'красная кнопка' });
    }
    return json({});
  };
  const rt = new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], script);
  const res = await new Pipeline({ repo: root, goal: 'сделай кнопки красными бля', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, autoApply: true }).run();
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');

  // планировщик получил подсказку, где кнопки
  assert.match(seen.plannerPrompt, /Где это, скорее всего, в коде[\s\S]*src\/shared\/ui\/generated\.css/);
  assert.match(journal, /Понял цель так: Кнопка «Добавить»/);
  assert.match(journal, /добавил общий файл стилей src\/shared\/ui\/generated\.css/);
  // приёмка поймала промах и доделала
  assert.match(journal, /цель НЕ достигнута — покрашена одна кнопка/);
  assert.match(journal, /Доделываю: D1\.1/);
  assert.match(journal, /Приёмка по цели \([^)]+\): цель достигнута/);
  assert.equal(seen.goalChecks, 2);
  // и результат — прямо в папке проекта, как ждёт Docker и dev-сервер
  assert.equal(res.applied?.ok, true, res.applied?.message ?? '');
  assert.match(readFileSync(path.join(root, 'src/shared/ui/generated.css'), 'utf8'), /\.af-btn\.primary \{ background: #d32f2f/);
  const report = readFileSync(path.join(res.runDir, 'report.md'), 'utf8');
  assert.match(report, /## Цель достигнута\?\n\n- Да/);
});

test('покрасили .af-btn, а .af-btn.primary перебивает — программа замечает, ревью возвращает, кодер доделывает', async () => {
  const root = makeWeb();
  let reviewSawHint = false;
  const script = (req: ChatRequest): ChatMessage => {
    const system = req.messages[0]?.content ?? '';
    const user = req.messages[1]?.content ?? '';
    const last = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
    if (system.includes('планировщик')) {
      return json({ understanding: 'Красные кнопки', tasks: [{ id: 'T1', type: 'edit', title: 'Красные кнопки', brief: 'Кнопкам красный фон', dependsOn: [], files: ['src/shared/ui/generated.css'], accept: { tests: [], commands: [] }, size: 'S' }] });
    }
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    if (system.includes('ревьюер')) {
      if (user.includes('Проверено программой по коду')) {
        reviewSawHint = true;
        return json({ verdict: 'changes', reasons: ['у .af-btn.primary свой фон — основные кнопки остались синими, поменяй его тоже'] });
      }
      return json({ verdict: 'approve', reasons: [] });
    }
    if (system.includes('кодер')) {
      if (/\.af-btn\.primary/.test(last) && /Ревью вернуло/.test(last + user)) {
        return json({ patches: [{ file: 'src/shared/ui/generated.css', search: '', replace: CSS.replace('background: #fff', 'background: #d32f2f').replace('background: #2f6fdb; border-color: #2f6fdb', 'background: #d32f2f; border-color: #d32f2f') }], note: 'и основные' });
      }
      return json({ patches: [{ file: 'src/shared/ui/generated.css', search: '.af-btn { padding: 7px 14px; background: #fff; }', replace: '.af-btn { padding: 7px 14px; background: #d32f2f; }' }], note: 'красные' });
    }
    return json({});
  };
  const rt = new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], script);
  const res = await new Pipeline({ repo: root, goal: 'кнопки красные', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, autoApply: true }).run();
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.ok(reviewSawHint, journal);
  assert.match(journal, /вернул T1: у \.af-btn\.primary свой фон/);
  assert.deepEqual(res.done, ['T1'], journal);
  assert.match(readFileSync(path.join(root, 'src/shared/ui/generated.css'), 'utf8'), /\.af-btn\.primary \{ background: #d32f2f/);
});

test('повтор прогона 20.10 02:38: покрасили только .danger — приёмка получает факт «.primary НЕ красный» и доделывает', async () => {
  const root = makeWeb();
  writeFileSync(path.join(root, 'src/shared/ui/generated.css'), CSS + '.af-btn.danger { color: #c0392b; border-color: #e6b0aa; }\n');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'danger'], { cwd: root });
  let factSeen = '';
  const script = (req: ChatRequest): ChatMessage => {
    const system = req.messages[0]?.content ?? '';
    const user = req.messages[1]?.content ?? '';
    const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
    if (system.includes('планировщик')) {
      // запрос планировщику больше не подсовывает danger/#c0392b как «красное»
      assert.doesNotMatch(user.slice(user.indexOf('Искал по словам цели'), user.indexOf('Искал по словам цели') + 200), /danger|#c0392b/);
      return json({ understanding: 'Красные кнопки удаления', tasks: [{ id: 'T1', type: 'edit', title: 'Красные кнопки', brief: '.af-btn.danger — красный фон', dependsOn: [], files: ['src/shared/ui/generated.css'], accept: { tests: [], commands: [] }, size: 'S' }] });
    }
    if (system.includes('приёмщик')) {
      const m = /НЕ красный — ([^\n]*)/.exec(user);
      if (m && m[1]!.includes('.af-btn.primary')) {
        factSeen = m[0];
        return json({ achieved: false, missing: ['основные кнопки (.af-btn.primary) остались синими'], tasks: [{ id: '1', type: 'edit', title: 'Основные кнопки', brief: '.af-btn.primary — фон #d32f2f', dependsOn: [], files: ['src/shared/ui/generated.css'], accept: { tests: [], commands: [] }, size: 'S' }] });
      }
      return json({ achieved: true, missing: [], tasks: [] });
    }
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('кодер')) {
      if (user.includes('.af-btn.primary — фон')) return json({ patches: [{ file: 'src/shared/ui/generated.css', search: '.af-btn.primary { background: #2f6fdb; border-color: #2f6fdb; color: #fff; }', replace: '.af-btn.primary { background: #d32f2f; border-color: #d32f2f; color: #fff; }' }], note: 'основные' });
      return json({ patches: [{ file: 'src/shared/ui/generated.css', search: '.af-btn.danger { color: #c0392b; border-color: #e6b0aa; }', replace: '.af-btn.danger { background: #c0392b; border-color: #c0392b; color: #fff; }' }], note: 'danger' });
    }
    return json({});
  };
  const rt = new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], script);
  const res = await new Pipeline({ repo: root, goal: 'сделай кнопки красными', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, autoApply: true }).run();
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.match(factSeen, /\.af-btn\.primary \(#2f6fdb\)/, journal);
  assert.match(journal, /цель НЕ достигнута — основные кнопки/);
  assert.match(readFileSync(path.join(root, 'src/shared/ui/generated.css'), 'utf8'), /\.af-btn\.primary \{ background: #d32f2f/);
});
