// Учебный репозиторий с двумя ошибками и сценарий «учебной модели» для прогона без Ollama.

import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { toolCall, MockRuntime } from './runtime/mock.ts';
import type { ChatMessage, ChatRequest } from './runtime/types.ts';

const FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    { name: 'agentyard-demo', version: '1.0.0', type: 'module', private: true, scripts: { test: 'node --test' } },
    null,
    2,
  ),
  'README.md': '# Учебный проект AgentYard\n\nДве функции с ошибками и тесты, которые падают. Конвейер должен починить код, не трогая тесты.\n',
  'src/price.js': `// Цена со скидкой в процентах.
export function applyDiscount(price, percent) {
  if (percent < 0 || percent > 100) throw new RangeError('percent must be 0..100');
  return Math.round(price * (percent / 100) * 100) / 100;
}
`,
  'src/text.js': `// Превращает заголовок в адрес страницы: "Hello World!" -> "hello-world".
export function slugify(title) {
  return title
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-');
}
`,
  'test/price.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount } from '../src/price.js';

test('скидка 20% от 100 = 80', () => {
  assert.equal(applyDiscount(100, 20), 80);
});

test('скидка 0% не меняет цену', () => {
  assert.equal(applyDiscount(59.9, 0), 59.9);
});
`,
  'test/text.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/text.js';

test('строчные буквы и дефисы', () => {
  assert.equal(slugify('Hello World!'), 'hello-world');
});

test('без дефисов по краям', () => {
  assert.equal(slugify('  --Agent Yard--  '), 'agent-yard');
});
`,
};

export function createDemoRepo(dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`Папка ${dir} не пустая`);
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=AgentYard', '-c', 'user.email=agentyard@localhost', 'commit', '-q', '-m', 'Учебный проект с двумя ошибками');
}

// ---------- «учебная модель» для демо и тестов ----------

const PRICE_FIX = {
  file: 'src/price.js',
  search: 'return Math.round(price * (percent / 100) * 100) / 100;',
  replace: 'return Math.round(price * (1 - percent / 100) * 100) / 100;',
};
/** Первая попытка намеренно неполная — чтобы было видно лестницу эскалации. */
const TEXT_FIX_PARTIAL = {
  file: 'src/text.js',
  search: "    .replace(/[^a-zA-Z0-9]+/g, '-');",
  replace: "    .toLowerCase()\n    .replace(/[^a-zA-Z0-9]+/g, '-');",
};
const TEXT_FIX_FULL = {
  file: 'src/text.js',
  search: "    .replace(/[^a-zA-Z0-9]+/g, '-');",
  replace: "    .toLowerCase()\n    .replace(/[^a-z0-9]+/g, '-')\n    .replace(/^-+|-+$/g, '');",
};

export function demoScript(): (req: ChatRequest) => ChatMessage {
  let textAttempts = 0;
  return (req) => {
    const system = req.messages[0]?.content ?? '';
    const user = req.messages[1]?.content ?? '';
    // какая задача: строка «T1: Починить test/price.test.js» в разделе «Задача»
    const task = /## Задача\n\n?([^\n]+)/.exec(user)?.[1] ?? '';
    const lastTool = [...req.messages].reverse().find((m) => m.role === 'tool');
    // прямой режим (есть схема ответа) — JSON в тексте; иначе — вызов инструмента
    const answer = (tool: string, args: Record<string, unknown>): ChatMessage =>
      req.format ? { role: 'assistant', content: JSON.stringify(args) } : toolCall(tool, args);

    if (system.includes('ревьюер')) return answer('submit_review', { verdict: 'approve', reasons: [] });
    if (system.includes('аналитик')) {
      return answer('submit_brief', { brief: 'Убери дефисы по краям и приводи к нижнему регистру до замены символов.', files: ['src/text.js'] });
    }
    if (task.includes('test/price.test.js')) {
      // в режиме с инструментами сначала «посмотрим» файл, потом сдадим — как настоящий агент
      if (!req.format && !lastTool) return toolCall('read_file', { path: 'src/price.js' });
      return answer('submit_patches', { patches: [PRICE_FIX], note: 'Скидка вычитается из цены, а не берётся как доля.' });
    }
    if (task.includes('test/text.test.js')) {
      if (req.messages.length === 2) textAttempts += 1;
      const patch = textAttempts === 1 ? TEXT_FIX_PARTIAL : TEXT_FIX_FULL;
      return answer('submit_patches', { patches: [patch], note: textAttempts === 1 ? 'Нижний регистр.' : 'Нижний регистр и обрезка дефисов по краям.' });
    }
    return { role: 'assistant', content: req.format ? '{}' : 'Не знаю, что делать.' };
  };
}

export function demoRuntime(): MockRuntime {
  return new MockRuntime(
    [
      { tag: 'qwen3.6:latest', sizeGb: 23 },
      { tag: 'gpt-oss:20b', sizeGb: 14 },
    ],
    demoScript(),
  );
}

// ---------- второй учебный проект: «магазин» и цель обычными словами ----------

export const FEATURE_GOAL =
  'Добавь промокоды: функция applyPromo(total, code) в новом файле src/promo.js. Код SAVE10 даёт скидку 10%, FIX500 — минус 500, но не ниже нуля; неизвестный код бросает ошибку с текстом «Неизвестный промокод». Покрой тестами в test/promo.test.js.';

const FEATURE_FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    { name: 'agentyard-shop', version: '1.0.0', type: 'module', private: true, scripts: { test: 'node --test' } },
    null,
    2,
  ),
  'README.md': '# Учебный магазин AgentYard\n\nКорзина, цены и доставка. Все тесты зелёные — задача конвейера добавить промокоды.\n',
  'src/cart.js': `// Корзина: список позиций { sku, price, qty }.
export function createCart() {
  return { items: [] };
}

export function addItem(cart, sku, price, qty = 1) {
  if (qty <= 0) throw new RangeError('qty must be positive');
  const found = cart.items.find((i) => i.sku === sku);
  if (found) found.qty += qty;
  else cart.items.push({ sku, price, qty });
  return cart;
}

export function cartTotal(cart) {
  return cart.items.reduce((sum, i) => sum + i.price * i.qty, 0);
}
`,
  'src/delivery.js': `// Доставка: бесплатно от 3000, иначе 300.
export function deliveryCost(total) {
  return total >= 3000 ? 0 : 300;
}
`,
  'test/cart.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCart, addItem, cartTotal } from '../src/cart.js';

test('сумма корзины', () => {
  const c = createCart();
  addItem(c, 'tea', 250, 2);
  addItem(c, 'cup', 900);
  assert.equal(cartTotal(c), 1400);
});

test('повторное добавление увеличивает количество', () => {
  const c = createCart();
  addItem(c, 'tea', 250);
  addItem(c, 'tea', 250, 3);
  assert.equal(c.items.length, 1);
  assert.equal(c.items[0].qty, 4);
});
`,
  'test/delivery.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryCost } from '../src/delivery.js';

test('бесплатная доставка от 3000', () => {
  assert.equal(deliveryCost(3000), 0);
  assert.equal(deliveryCost(2999), 300);
});
`,
};

export function createFeatureRepo(dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`Папка ${dir} не пустая`);
  for (const [rel, content] of Object.entries(FEATURE_FILES)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=AgentYard', '-c', 'user.email=agentyard@localhost', 'commit', '-q', '-m', 'Учебный магазин');
}

export const PROMO_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPromo } from '../src/promo.js';

test('SAVE10 — скидка 10%', () => {
  assert.equal(applyPromo(1000, 'SAVE10'), 900);
});

test('FIX500 — минус 500, но не ниже нуля', () => {
  assert.equal(applyPromo(1200, 'FIX500'), 700);
  assert.equal(applyPromo(300, 'FIX500'), 0);
});

test('неизвестный код — ошибка', () => {
  assert.throws(() => applyPromo(1000, 'NOPE'), /Неизвестный промокод/);
});
`;

export const PROMO_COVERAGE = {
  requirements: [
    { requirement: 'SAVE10 — скидка 10%', check: "assert.equal(applyPromo(1000, 'SAVE10'), 900);" },
    { requirement: 'FIX500 — минус 500', check: "assert.equal(applyPromo(1200, 'FIX500'), 700);" },
    { requirement: 'FIX500 — не ниже нуля', check: "assert.equal(applyPromo(300, 'FIX500'), 0);" },
    { requirement: 'Неизвестный код — ошибка «Неизвестный промокод»', check: "assert.throws(() => applyPromo(1000, 'NOPE'), /Неизвестный промокод/);" },
  ],
  verdict: 'approve',
  reasons: [],
};

export const PROMO_CODE = `// Промокоды.
export function applyPromo(total, code) {
  if (code === 'SAVE10') return Math.round(total * 0.9 * 100) / 100;
  if (code === 'FIX500') return Math.max(0, total - 500);
  throw new Error('Неизвестный промокод');
}
`;

/** Учебная модель для «магазина»: планировщик, тестировщик, кодер, ревьюер. */
export function featureScript(): (req: ChatRequest) => ChatMessage {
  return (req) => {
    const system = req.messages[0]?.content ?? '';
    const user = req.messages[1]?.content ?? '';
    const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
    if (system.includes('планировщик')) {
      return json({
        tasks: [
          {
            id: 'T1',
            type: 'edit',
            title: 'Промокоды applyPromo',
            brief: 'Создай src/promo.js с функцией applyPromo(total, code): SAVE10 — минус 10%, FIX500 — минус 500 не ниже нуля, иначе ошибка «Неизвестный промокод».',
            dependsOn: [],
            files: ['src/promo.js'],
            newFiles: ['src/promo.js'],
            accept: { tests: ['test/promo.test.js'], commands: [] },
            size: 'S',
            testFirst: true,
          },
        ],
      });
    }
    if (system.includes('приёмщик')) {
      // приёмка по цели: промокоды на месте, если в итоговых изменениях есть src/promo.js
      const diff = user.slice(user.indexOf('## Итоговые изменения'));
      return json(diff.includes('src/promo.js') ? { achieved: true, missing: [], tasks: [] } : { achieved: false, missing: ['нет src/promo.js'], tasks: [] });
    }
    if (system.includes('ревьюер')) {
      // ревью теста — по пунктам: требование и строка теста, которая его проверяет
      if (user.includes('"requirements"')) return json(PROMO_COVERAGE);
      return json({ verdict: 'approve', reasons: [] });
    }
    if (system.includes('тестировщик')) return json({ patches: [{ file: 'test/promo.test.js', search: '', replace: PROMO_TEST }], note: 'Тесты на три случая.' });
    if (system.includes('кодер') && user.includes('src/promo.js')) {
      return json({ patches: [{ file: 'src/promo.js', search: '', replace: PROMO_CODE }], note: 'Функция applyPromo.' });
    }
    return json({});
  };
}

export function featureRuntime(): MockRuntime {
  return new MockRuntime(
    [
      { tag: 'qwen3.6:latest', sizeGb: 23 },
      { tag: 'gpt-oss:20b', sizeGb: 14 },
    ],
    featureScript(),
  );
}

/** Какой учебный проект лежит в папке (по характерным файлам) — чтобы подсказать цель. */
export function detectDemo(dir: string): 'fix' | 'shop' | 'web' | null {
  const has = (f: string) => existsSync(path.join(dir, f));
  if (has('src/shared/ui/generated.css') && has('src/pages/address-list/ui/AddressListPage.tsx') && has('README.md') && readFileSync(path.join(dir, 'README.md'), 'utf8').includes('Учебный сайт')) return 'web';
  if (has('src/cart.js') && has('src/delivery.js')) return 'shop';
  if (has('src/price.js') && has('src/text.js')) return 'fix';
  return null;
}

// ---------- учебный «сайт»: сгенерированные страницы с общим CSS (как у пользователя в web/) ----------

const WEB_ENTITIES: [string, string, string][] = [
  ['address', 'addresses', 'Адреса'],
  ['user', 'users', 'Пользователи'],
  ['order', 'orders', 'Заказы'],
  ['product', 'products', 'Товары'],
  ['payment', 'payments', 'Платежи'],
  ['review', 'reviews', 'Отзывы'],
];
const WEB_CSS = "/* Нейтральные стили сгенерированных страниц. Замените на компоненты UI-кита — логика не изменится. */\n.af-page { max-width: 1100px; margin: 0 auto; padding: 24px 16px; font: 14px/1.5 system-ui, sans-serif; color: #1b2430; }\n.af-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }\n.af-head h1 { font-size: 22px; margin: 0; }\n.af-filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }\n.af-table { width: 100%; border-collapse: collapse; }\n.af-table th, .af-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e3e7ee; }\n.af-table th { font-weight: 600; color: #46556a; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }\n.af-table tr:hover td { background: #f6f8fb; }\n.af-pager { display: flex; align-items: center; gap: 8px; margin-top: 12px; color: #46556a; }\n.af-btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 6px; border: 1px solid #c9d1dc; background: #fff; cursor: pointer; font: inherit; color: inherit; text-decoration: none; }\n.af-btn.primary { background: #2f6fdb; border-color: #2f6fdb; color: #fff; }\n.af-btn.danger { color: #c0392b; border-color: #e6b0aa; }\n.af-btn:disabled { opacity: .5; cursor: default; }\n.af-form { display: grid; gap: 14px; max-width: 560px; }\n.af-field { display: grid; gap: 4px; }\n.af-field label { font-weight: 600; font-size: 13px; }\n.af-field input, .af-field select, .af-field textarea { padding: 8px 10px; border: 1px solid #c9d1dc; border-radius: 6px; font: inherit; }\n.af-field input[type='checkbox'] { justify-self: start; }\n.af-field .af-error { color: #c0392b; font-size: 12px; }\n.af-alert { padding: 10px 12px; border-radius: 6px; background: #fdecea; color: #8e2a1f; margin-bottom: 12px; }\n.af-card { display: grid; grid-template-columns: 200px 1fr; gap: 8px 16px; }\n.af-card dt { color: #46556a; }\n.af-card dd { margin: 0; }\n.af-nav { display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 12px 16px; border-bottom: 1px solid #e3e7ee; }\n.af-nav a { color: #2f6fdb; text-decoration: none; }\n.af-muted { color: #8a97a8; }\n";
const WEB_PAGE = `'use client'

import { useState } from 'react'
import Link from 'next/link'
import { use{Ps}List } from '../../../entities/{one}/index'
import '../../../shared/ui/generated.css'

const PAGE = 20

/** Список «{title}»: таблица и переключатель страниц. */
export function {P}ListPage() {
  const [offset, setOffset] = useState(0)
  const { data, isLoading, error } = use{Ps}List({}, PAGE, offset)
  const total = data?.total ?? 0

  return (
    <div className="af-page">
      <div className="af-head">
        <h1>{title}</h1>
        <Link className="af-btn primary" href="/{many}/new">
          Добавить
        </Link>
      </div>
      {error ? <div className="af-alert">Не удалось загрузить: {String((error as Error).message)}</div> : null}
      {isLoading ? (
        <p className="af-muted">Загрузка…</p>
      ) : (
        <table className="af-table">
          <thead>
            <tr>
              <th>Название</th>
              <th>Создано</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((row) => (
              <tr key={String(row.id)}>
                <td>
                  <Link href={\`/{many}/\${row.id}\`}>{String(row.name)}</Link>
                </td>
                <td>{String(row.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="af-pager">
        <button className="af-btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
          ← Назад
        </button>
        <span>
          {total ? \`\${offset + 1}–\${Math.min(offset + PAGE, total)} из \${total}\` : '0'}
        </span>
        <button className="af-btn" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
          Вперёд →
        </button>
      </div>
    </div>
  )
}
`;
const WEB_EDIT = `'use client'

import Link from 'next/link'
import '../../../shared/ui/generated.css'

/** Создание записи «{title}». */
export function {P}EditPage() {
  return (
    <div className="af-page">
      <div className="af-head">
        <h1>Новая запись: {title}</h1>
        <Link className="af-btn" href="/{many}">
          К списку
        </Link>
      </div>
      <form className="af-form">
        <div className="af-field">
          <label>Название</label>
          <input name="name" />
        </div>
        <button className="af-btn primary" type="submit">
          Сохранить
        </button>
      </form>
    </div>
  )
}
`;
const WEB_NAV = "'use client'\n\nimport Link from 'next/link'\n\nconst ITEMS = [\n  { to: '/addresses', title: \"Адреса\" },\n  { to: '/audit-log-entries', title: \"Журнал изменений\" },\n  { to: '/categories', title: \"Категории\" },\n  { to: '/files', title: \"Файлы\" },\n  { to: '/notifications', title: \"Уведомления\" },\n  { to: '/order-items', title: \"Состав заказа\" },\n  { to: '/orders', title: \"Заказы\" },\n  { to: '/payments', title: \"Платежи\" },\n  { to: '/pidorushkies', title: \"pidorushky\" },\n  { to: '/product-images', title: \"Картинки товаров\" },\n  { to: '/products', title: \"Товары\" },\n  { to: '/refunds', title: \"Возвраты\" },\n  { to: '/reviews', title: \"Отзывы\" },\n  { to: '/roles', title: \"Роли\" },\n  { to: '/sessions', title: \"Входы и сессии\" },\n  { to: '/users', title: \"Пользователи\" },\n]\n\n/** Меню по всем сущностям. */\nexport function GeneratedNav() {\n  return (\n    <nav className=\"af-nav\">\n      {ITEMS.map((i) => (\n        <Link key={i.to} href={i.to}>\n          {i.title}\n        </Link>\n      ))}\n    </nav>\n  )\n}\n";

function webFiles(): Record<string, string> {
  const pascal = (s: string) => s.split('-').map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'agentyard-web', private: true, version: '0.1.0', scripts: { dev: 'next dev -p 3000' }, dependencies: { next: '^15.3.0', react: '^19.1.0', 'react-dom': '^19.1.0' } }, null, 2),
    'README.md': '# Учебный сайт AgentYard\n\nСгенерированные страницы списков с общим CSS (src/shared/ui/generated.css). Тестов нет — как часто бывает у фронтенда.\n',
    Dockerfile: 'FROM node:22-alpine\nWORKDIR /app\nCOPY package.json ./\nRUN npm install --no-audit --no-fund\nCOPY . .\nENV HOST=0.0.0.0 PORT=3000\nEXPOSE 3000\nCMD ["npm", "run", "dev"]\n',
    'src/shared/ui/generated.css': WEB_CSS,
    'src/widgets/generated-nav/ui/GeneratedNav.tsx': WEB_NAV,
    'app/layout.tsx': "import type { ReactNode } from 'react'\n\nexport const metadata = { title: 'Учебный сайт' }\n\nexport default function RootLayout({ children }: { children: ReactNode }) {\n  return (\n    <html lang=\"ru\">\n      <body>{children}</body>\n    </html>\n  )\n}\n",
    'app/(generated)/layout.tsx': "'use client'\n\nimport type { ReactNode } from 'react'\nimport { GeneratedNav } from '../../src/widgets/generated-nav/ui/GeneratedNav'\n\n/** Общая обёртка сгенерированных страниц: меню. */\nexport default function GeneratedLayout({ children }: { children: ReactNode }) {\n  return (\n    <>\n      <GeneratedNav />\n      {children}\n    </>\n  )\n}\n",
  };
  for (const [one, many, title] of WEB_ENTITIES) {
    const P = pascal(one);
    const Ps = pascal(many);
    files[`src/pages/${one}-list/ui/${P}ListPage.tsx`] = WEB_PAGE.replace(/\{Ps\}/g, Ps).replace(/\{P\}/g, P).replace(/\{one\}/g, one).replace(/\{many\}/g, many).replace(/\{title\}/g, title);
    files[`src/pages/${one}-list/index.ts`] = `export * from './ui/${P}ListPage'\n`;
    files[`app/(generated)/${many}/page.tsx`] = `export { ${P}ListPage as default } from '../../../src/pages/${one}-list/index'\n`;
    files[`src/pages/${one}-edit/ui/${P}EditPage.tsx`] = WEB_EDIT.replace(/\{P\}/g, P).replace(/\{many\}/g, many).replace(/\{title\}/g, title);
    files[`src/pages/${one}-edit/index.ts`] = `export * from './ui/${P}EditPage'\n`;
    files[`app/(generated)/${many}/new/page.tsx`] = `export { ${P}EditPage as default } from '../../../../src/pages/${one}-edit/index'\n`;
  }
  return files;
}

/** Учебный сайт: оформление и тексты, тестов нет. */
export function createWebRepo(dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`Папка ${dir} не пустая`);
  for (const [rel, content] of Object.entries(webFiles())) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=AgentYard', '-c', 'user.email=agentyard@localhost', 'commit', '-q', '-m', 'Учебный сайт');
}
