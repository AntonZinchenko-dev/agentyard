// Повтор прогона 20261020144005 («Тест мусор»: backend на Go + web на Next).
// Тогда: задачу про web/app/layout.tsx проверял `go test` бэкенда, красный ещё до прогона (нет go.sum).
// Пять попыток верной правки, дробление на тест в корне (его нечем запустить), «старший» — и человек.
// Пакет @mantine/core планировщик ставить не велел, а ставить его было бы некуда: в корне нет package.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockRuntime } from '../src/runtime/mock.ts';
import { Pipeline } from '../src/pipeline.ts';
import { loadCatalog } from '../src/catalog.ts';
import { Stats } from '../src/stats.ts';
import type { ChatMessage } from '../src/runtime/types.ts';
import type { Hardware } from '../src/types.ts';

process.env.AGENTYARD_NPM = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-npm.mjs');
const HW: Hardware = { gpuName: 'test', vramTotalGb: 16, vramFreeGb: 16, ramTotalGb: 32, ramFreeGb: 24, cpuCores: 8, unifiedMemory: false, tier: 'T2' };
const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
const HAS_GO = spawnSync('go', ['version']).status === 0;

const LAYOUT = `import type { ReactNode } from 'react'

export const metadata = { title: "Новый проект" }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  )
}
`;
const NAV = `'use client'

import Link from 'next/link'

const ITEMS = [
  { to: '/addresses', title: "Адреса" },
  { to: '/orders', title: "Заказы" },
]

/** Меню по всем сущностям. */
export function GeneratedNav() {
  return (
    <nav className="af-nav">
      {ITEMS.map((i) => (
        <Link key={i.to} href={i.to}>
          {i.title}
        </Link>
      ))}
    </nav>
  )
}
`;

/** Проект как у человека: бэкенд с красными до прогона тестами и web без тестов и без node_modules. */
function musor(): string {
  const root = path.join(mkdtempSync(path.join(tmpdir(), 'ay-musor-')), 'Тест мусор');
  const w = (f: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), text);
  };
  if (HAS_GO) {
    // настоящий Go: модуль требует chi, а go.sum нет — go vet и go test падают ещё до прогона
    w('backend/go.mod', 'module novyy-proekt\n\ngo 1.21\n\nrequire github.com/go-chi/chi/v5 v5.1.0\n');
    w('backend/internal/httpapi/router.go', 'package httpapi\n\nimport "github.com/go-chi/chi/v5"\n\n// Router — маршруты API.\nfunc Router() *chi.Mux { return chi.NewRouter() }\n');
    w('backend/internal/httpapi/router_test.go', 'package httpapi\n\nimport "testing"\n\nfunc TestRouter(t *testing.T) { _ = Router() }\n');
  } else {
    // без Go на компьютере — бэкенд с тем же свойством: его тесты красные ещё до прогона
    w('backend/package.json', JSON.stringify({ name: 'backend', private: true, scripts: { test: 'node red.mjs' } }, null, 2));
    w('backend/red.mjs', "console.log('FAIL\\tnovyy-proekt/cmd/server [setup failed]');\nconsole.log('internal/httpapi/router.go:26:2: missing go.sum entry for module providing package github.com/go-chi/chi/v5');\nprocess.exit(1);\n");
  }
  w('web/package.json', JSON.stringify({ name: 'novyy-proekt-web', private: true, scripts: { build: 'next build', dev: 'next dev' }, dependencies: { next: '^15.3.0', react: '^19.1.0', 'react-dom': '^19.1.0' }, devDependencies: { typescript: '^5.8.3' } }, null, 2));
  w('web/tsconfig.json', '{ "compilerOptions": { "jsx": "preserve", "strict": true } }\n');
  w('web/app/layout.tsx', LAYOUT);
  w('web/src/widgets/generated-nav/ui/GeneratedNav.tsx', NAV);
  w('web/src/shared/ui/generated.css', '.af-nav { display: flex; gap: 8px; }\n');
  w('README.md', '# Новый проект\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'AgentYard: исходное состояние'], { cwd: root });
  return root;
}

// план того прогона: тест в корне (раннера нет), пакеты не указаны
const PLAN = [
  { id: 'T1', type: 'edit', title: 'Подключить Mantine и обернуть layout', brief: 'Добавить пакеты @mantine/core и @mantine/hooks, импортировать стили и MantineProvider в web/app/layout.tsx, обернуть {children} в <MantineProvider>.', dependsOn: [], files: ['web/app/layout.tsx'], accept: { tests: ['tests/layout-mantine-provider.test.tsx'], commands: [] }, size: 'S' },
  { id: 'T2', type: 'edit', title: 'Сделать шапку кнопками Mantine', brief: 'В меню шапки заменить ссылки на Button из @mantine/core (component={Link}), обернуть в Group.', dependsOn: ['T1'], files: ['web/src/widgets/generated-nav/ui/GeneratedNav.tsx'], accept: { tests: [], commands: [] }, size: 'S' },
];

test('монорепо: задачи про web проверяются своей частью, красный бэкенд не в счёт, пакет ставит программа в web/ — без человека', async () => {
  const repo = musor();
  const coder: string[] = [];
  const rt = new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], (req) => {
    const system = req.messages[0]?.content ?? '';
    const user = req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('планировщик')) return json({ understanding: 'Mantine: провайдер в layout и шапка кнопками', tasks: PLAN });
    const id = /## Задача\s+(\S+?):/.exec(user)?.[1] ?? '';
    coder.push(id);
    if (id === 'T1') {
      return json({
        patches: [
          { file: 'web/app/layout.tsx', search: "import type { ReactNode } from 'react'", replace: "import '@mantine/core/styles.css'\nimport { MantineProvider } from '@mantine/core'\nimport type { ReactNode } from 'react'" },
          { file: 'web/app/layout.tsx', search: '<body>{children}</body>', replace: '<body>\n        <MantineProvider>{children}</MantineProvider>\n      </body>' },
        ],
        note: 'MantineProvider в layout',
      });
    }
    return json({
      patches: [
        { file: 'web/src/widgets/generated-nav/ui/GeneratedNav.tsx', search: "import Link from 'next/link'", replace: "import Link from 'next/link'\nimport { Button, Group } from '@mantine/core'" },
        { file: 'web/src/widgets/generated-nav/ui/GeneratedNav.tsx', search: '    <nav className="af-nav">\n      {ITEMS.map((i) => (\n        <Link key={i.to} href={i.to}>\n          {i.title}\n        </Link>\n      ))}\n    </nav>', replace: '    <Group component="nav" gap="xs" className="af-nav">\n      {ITEMS.map((i) => (\n        <Button key={i.to} component={Link} href={i.to} variant="subtle">\n          {i.title}\n        </Button>\n      ))}\n    </Group>' },
      ],
      note: 'шапка кнопками',
    });
  });
  const r = await new Pipeline({ repo, goal: 'Подтяни юай кит, замени таблицы на таблицы из кита, сделай красивую шапку', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, allowInstall: true }).run();
  const journal = readFileSync(path.join(r.runDir, 'journal.txt'), 'utf8');

  assert.deepEqual(r.human, [], journal);
  assert.deepEqual(r.done.sort(), ['T1', 'T2'], journal);
  assert.deepEqual(coder, ['T1', 'T2'], 'каждая задача — с первого раза');
  // тест в корне, который нечем запустить, убран ещё в плане — никакого «красного теста» go test'ом
  assert.match(journal, /Тесты, которые нечем запустить в их части проекта, убраны/);
  assert.doesNotMatch(journal, /T1\.1|красный тест|ступень [3-6]|разбор неудачи/);
  // пакет поставлен в web/, а не в корень
  assert.match(journal, /правка импортирует @mantine\/core, а в зависимостях её части их нет — ставлю пакеты сам/);
  assert.ok(existsSync(path.join(repo, 'web/node_modules/@mantine/core/package.json')));
  assert.ok(!existsSync(path.join(repo, 'node_modules')));
  const webPkg = JSON.parse(execFileSync('git', ['show', `${r.branch}:web/package.json`], { cwd: repo, encoding: 'utf8' }));
  assert.ok(webPkg.dependencies['@mantine/core'], 'зависимость дописана в web/package.json');
  // проверки web-задач не запускали бэкенд
  const events = readFileSync(path.join(r.runDir, 'events.jsonl'), 'utf8');
  assert.doesNotMatch(events.split('\n').filter((l) => /"type":"checks"/.test(l)).join('\n'), /setup failed|go\.sum/);
  // ссылка на node_modules части не попала в коммит
  const files = execFileSync('git', ['diff', '--name-only', `HEAD..${r.branch}`], { cwd: repo, encoding: 'utf8' });
  assert.doesNotMatch(files, /node_modules/);
});

test('монорепо: задача бэкенда — красные до прогона тесты не её вина, новое падение — её', { skip: !HAS_GO && 'нет Go на этом компьютере' }, async () => {
  const repo = musor();
  const plan = [{ id: 'B1', type: 'edit', title: 'Комментарий к роутеру', brief: 'Описать функцию Router подробнее.', dependsOn: [], files: ['backend/internal/httpapi/router.go'], accept: { tests: ['backend/internal/httpapi/router_test.go'], commands: [] }, size: 'S' }];
  let calls = 0;
  const rt = new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], (req) => {
    const system = req.messages[0]?.content ?? '';
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('планировщик')) return json({ understanding: 'x', tasks: plan });
    calls++;
    return json({ patches: [{ file: 'backend/internal/httpapi/router.go', search: '// Router — маршруты API.', replace: '// Router собирает маршруты API (chi).' }], note: 'комментарий' });
  });
  const r = await new Pipeline({ repo, goal: 'опиши роутер', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true }).run();
  const journal = readFileSync(path.join(r.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(r.done, ['B1'], journal);
  assert.equal(calls, 1);
  assert.match(journal, /падает так же, как до прогона/);
});

test('монорепо: планировщик сам велел поставить пакеты — план проходит, пакеты ставятся в web/, а не «только в проекте с package.json»', async () => {
  const repo = musor();
  // как в прогоне 20:32: отдельная задача «поставить пакеты» без файлов и install у правки
  const plan = [
    { id: 'T0', type: 'edit', title: 'Поставить Mantine', brief: 'Поставить @mantine/core и @mantine/hooks.', dependsOn: [], files: [], accept: { tests: [], commands: [] }, size: 'S', install: ['@mantine/core', '@mantine/hooks'] },
    { ...PLAN[0], dependsOn: ['T0'], install: ['@mantine/core'], accept: { tests: [], commands: [] } },
  ];
  const rt = new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], (req) => {
    const system = req.messages[0]?.content ?? '';
    if (system.includes('приёмщик')) return json({ achieved: true, missing: [], tasks: [] });
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });
    if (system.includes('планировщик')) return json({ understanding: 'Mantine', tasks: plan });
    return json({ patches: [{ file: 'web/app/layout.tsx', search: "import type { ReactNode } from 'react'", replace: "import { MantineProvider } from '@mantine/core'\nimport type { ReactNode } from 'react'" }, { file: 'web/app/layout.tsx', search: '<body>{children}</body>', replace: '<body><MantineProvider>{children}</MantineProvider></body>' }], note: 'provider' });
  });
  const r = await new Pipeline({ repo, goal: 'подтяни юай кит', runtime: rt, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, allowInstall: true }).run();
  const journal = readFileSync(path.join(r.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(r.human, [], journal);
  assert.deepEqual(r.done, ['T1'], journal);
  assert.match(journal, /будут установлены пакеты npm в web\/: @mantine\/core/);
  assert.ok(existsSync(path.join(repo, 'web/node_modules/@mantine/hooks/package.json')));
  const webPkg = JSON.parse(execFileSync('git', ['show', `${r.branch}:web/package.json`], { cwd: repo, encoding: 'utf8' }));
  assert.ok(webPkg.dependencies['@mantine/core'] && webPkg.dependencies['@mantine/hooks'], JSON.stringify(webPkg.dependencies));
});
