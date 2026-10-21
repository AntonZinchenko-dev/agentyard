// Небрежная цель → место в коде. «Пьяные» формулировки из реальных прогонов.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { goalTerms, searchRepo } from '../src/context.ts';
import { buildRepoMap } from '../src/repomap.ts';

function makeWeb(): string {
  const root = path.join(mkdtempSync(path.join(tmpdir(), 'ay-ctx-')), 'web');
  const w = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  w('package.json', '{"name":"web"}');
  w('Dockerfile', 'FROM node:22-alpine\nENV PORT=3000\nEXPOSE 3000\nCMD ["npm","run","dev"]\n');
  w('src/shared/ui/generated.css', '.af-head { display: flex; }\n.af-table th { color: #46556a; }\n.af-btn { padding: 7px 14px; background: #fff; }\n.af-btn.primary { background: #2f6fdb; color: #fff; }\n');
  w('src/widgets/nav/ui/Nav.tsx', 'export function Nav() { return <nav className="af-nav"><a href="/x">x</a></nav> }\n');
  for (const e of ['address', 'user', 'order', 'payment', 'role', 'file']) {
    const P = e[0]!.toUpperCase() + e.slice(1);
    w(`src/pages/${e}-list/ui/${P}ListPage.tsx`, `export function ${P}ListPage() {\n  return <div className="af-page"><div className="af-head"><h1>${P === 'Address' ? 'Адреса' : P}</h1><Link className="af-btn primary" href="/${e}/new">Добавить</Link></div><table className="af-table"><thead><tr><th>a</th></tr></thead></table></div>\n}\n`);
  }
  return root;
}

const top = (root: string, goal: string) => searchRepo(root, buildRepoMap(root).files, goalTerms(goal), 3).map((h) => h.file);

test('ругательства и шум не мешают, «кнопки красными» ведут в общий CSS', () => {
  const root = makeWeb();
  const q = goalTerms('бля сделай короче кнопки красными плиз');
  assert.ok(q.terms.includes('btn') && q.terms.includes('red'));
  assert.ok(!q.terms.some((t) => /бля|короче|плиз/.test(t)));
  assert.equal(top(root, 'бля сделай короче кнопки красными плиз')[0], 'src/shared/ui/generated.css');
});

test('надпись на кнопке ловится как текст на экране', () => {
  const q = goalTerms('кнопку добавить сделай красной');
  assert.ok(q.literals.includes('Добавить'));
});

test('«шапку таблицы липкой», «докер порт», «заголовок адресов»', () => {
  const root = makeWeb();
  assert.equal(top(root, 'шапку таблицы сделай липкой')[0], 'src/shared/ui/generated.css');
  assert.equal(top(root, 'чтоб шапка у таблиц не уезжала когда листаешь')[0], 'src/shared/ui/generated.css');
  assert.equal(top(root, 'в докер файле порт поменяй на 8080')[0], 'Dockerfile');
  assert.equal(top(root, 'заголовок на странице адресов поменяй на «Адреса доставки»')[0], 'src/pages/address-list/ui/AddressListPage.tsx');
});

test('близнецы не забивают выдачу: из 6 одинаковых страниц — не больше двух', () => {
  const root = makeWeb();
  const files = searchRepo(root, buildRepoMap(root).files, goalTerms('кнопки'), 10).map((h) => h.file);
  assert.ok(files.filter((f) => f.startsWith('src/pages/')).length <= 2, files.join(', '));
});

test('английские и с опечатками: «make buttons red», «кнопкм красныи»', () => {
  const root = makeWeb();
  assert.equal(top(root, 'make the buttons red pls')[0], 'src/shared/ui/generated.css');
  assert.equal(top(root, 'кнопкм красныи сдеай')[0], 'src/shared/ui/generated.css');
  assert.equal(top(root, 'docker port 8080')[0], 'Dockerfile');
});
