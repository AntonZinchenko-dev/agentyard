// Движок: части проекта, сравнение с исходным состоянием, разбор неудач, политика следующего шага, цена смен моделей.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeDirFor, scopedCommands, stackOf, testCommandsFor, hasTestRunner } from '../src/engine/workspace.ts';
import { BaselineRunner, compareOutcomes, failureKeys } from '../src/engine/baseline.ts';
import { filesInOutput, missingFromOutput, missingPackages, packageOfSpecifier, triage } from '../src/engine/triage.ts';
import { decide, type AttemptLog } from '../src/engine/policy.ts';
import { ett, epochRate, worthInterrupting } from '../src/engine/scheduler.ts';
import { combinedCommands, type Stack } from '../src/stacks.ts';
import { adaptToProject } from '../src/plan.ts';
import { loadCatalog } from '../src/catalog.ts';
import { Stats } from '../src/stats.ts';
import type { PlannedTask, Task, Team } from '../src/types.ts';

// части проекта из прогона 20261020144005: backend на Go, web на Next без тестов
const GO: Stack = { id: 'go', dir: 'backend', name: 'Go', test: 'go test ./...', testFiles: null, lint: null, typecheck: 'go vet ./...', tags: [] };
const WEB: Stack = { id: 'node', dir: 'web', name: 'Node (Next.js)', test: null, testFiles: null, lint: null, typecheck: null, tags: [] };
const STACKS = [GO, WEB];
const ALL = combinedCommands(STACKS);

test('части проекта: задача про web не проверяется go test бэкенда; тесты — раннером своей части', () => {
  assert.equal(stackOf('web/app/layout.tsx', STACKS), WEB);
  assert.equal(stackOf('backend/internal/a.go', STACKS), GO);
  assert.equal(stackOf('README.md', STACKS), null);
  assert.equal(ALL.test, 'cd "backend" && go test ./...', 'общая команда — бэкенд');
  assert.deepEqual(scopedCommands(['web/app/layout.tsx'], STACKS, ALL), { test: null, testFiles: null, lint: null, typecheck: null });
  assert.equal(scopedCommands(['backend/internal/a.go'], STACKS, ALL).test, 'cd "backend" && go test ./...');
  // тест в корне и в web/ — запустить нечем; у бэкенда — весь набор (не «ровно тесты задачи»)
  assert.deepEqual(testCommandsFor(['tests/layout.test.tsx', 'web/tests/a.test.tsx'], STACKS, ALL), { commands: [], unrunnable: ['tests/layout.test.tsx', 'web/tests/a.test.tsx'], specific: true });
  assert.deepEqual(testCommandsFor(['backend/internal/a_test.go'], STACKS, ALL), { commands: ['cd "backend" && go test ./...'], unrunnable: [], specific: false });
  const vit: Stack = { ...WEB, test: 'npm test', testFiles: 'npx --no-install vitest run {files}' };
  assert.deepEqual(testCommandsFor(['web/src/a.test.ts'], [GO, vit], combinedCommands([GO, vit])).commands, ['cd "web" && npx --no-install vitest run "src/a.test.ts"']);
  assert.equal(hasTestRunner(['web/app/layout.tsx'], STACKS, ALL), false);
  assert.equal(nodeDirFor(['web/app/layout.tsx'], STACKS), 'web');
  // проект из одной части — как раньше
  const one: Stack = { ...WEB, dir: '', test: 'npm test', testFiles: 'node --test {files}' };
  const oneCmd = combinedCommands([one]);
  assert.deepEqual(scopedCommands(['src/a.js'], [one], oneCmd), oneCmd);
  assert.deepEqual(testCommandsFor(['test/a.test.js'], [one], oneCmd), { commands: ['node --test "test/a.test.js"'], unrunnable: [], specific: true });
});

test('план: тест, который нечем запустить в его части, убирается; критерий — без него', () => {
  const t = (o: Partial<PlannedTask> & { id: string }): PlannedTask => ({ type: 'edit', title: o.id, brief: 'x', dependsOn: [], files: [], accept: { tests: [], commands: [] }, size: 'S', ...o });
  const warnings: string[] = [];
  const plan = adaptToProject(
    {
      goal: 'x',
      tasks: [
        t({ id: 'T1', files: ['web/app/layout.tsx'], accept: { tests: ['tests/layout-mantine-provider.test.tsx'], commands: [] } }),
        t({ id: 'T1-test', type: 'test', files: ['tests/layout-mantine-provider.test.tsx'], newFiles: ['tests/layout-mantine-provider.test.tsx'], accept: { tests: ['tests/layout-mantine-provider.test.tsx'], commands: [] } }),
        t({ id: 'T2', files: ['backend/internal/a.go'], dependsOn: ['T1-test'], accept: { tests: ['backend/internal/a_test.go'], commands: [] } }),
      ],
    },
    ALL,
    warnings,
    STACKS,
  );
  assert.deepEqual(plan.tasks.map((x) => x.id), ['T1', 'T2']);
  assert.deepEqual(plan.tasks[0]!.accept.tests, []);
  assert.match(plan.tasks[0]!.brief, /Тестов не писать/);
  assert.deepEqual(plan.tasks[1]!.accept.tests, ['backend/internal/a_test.go']);
  assert.deepEqual(plan.tasks[1]!.dependsOn, []);
  assert.match(warnings.join('\n'), /нечем запустить/);
});

// настоящий вывод go test из прогона (Windows, нет go.sum)
const GO_RED = `FAIL\tnovyy-proekt/cmd/server [setup failed]
FAIL\tnovyy-proekt/internal/address [setup failed]
?   \tnovyy-proekt/internal/platform/apperr\t[no test files]
FAIL

# novyy-proekt/cmd/server
internal\\httpapi\\router.go:26:2: missing go.sum entry for module providing package github.com/go-chi/chi/v5 (imported by novyy-proekt/internal/httpapi); to add:
\tgo get novyy-proekt/internal/httpapi`;

test('сравнение с исходным состоянием: те же падения — не вина задачи; новое — её', () => {
  const keys = failureKeys(GO_RED);
  assert.ok(keys.has('gopkg|novyy-proekt/cmd/server'));
  assert.ok(keys.has('env|gosum|github.com/go-chi/chi/v5'));
  // то же падение в рабочей копии задачи (другой путь, другое время)
  const cur = { code: 1, output: GO_RED.replace('[setup failed]', '[setup failed]') };
  assert.deepEqual(compareOutcomes(cur, { code: 1, output: GO_RED }), { preexisting: true, fresh: [], before: 3 });
  // задача добавила своё падение
  const worse = { code: 1, output: `${GO_RED}\n--- FAIL: TestCreate (0.00s)\nFAIL\tnovyy-proekt/internal/order\t0.01s` };
  const c = compareOutcomes(worse, { code: 1, output: GO_RED });
  assert.equal(c.preexisting, false);
  assert.deepEqual(c.fresh.map((l) => l.trim()), ['--- FAIL: TestCreate (0.00s)', 'FAIL\tnovyy-proekt/internal/order\t0.01s'.trim()]);
  // на исходном состоянии всё зелёное — любое падение задачи
  assert.equal(compareOutcomes({ code: 1, output: 'not ok 1 - a' }, { code: 0, output: '' }).preexisting, false);
  // ошибки tsc мешком: была одна TS2322 в файле, стало две — одна новая
  const ts = "src/a.tsx(3,5): error TS2322: Type 'x' is not assignable to type 'y'.";
  assert.equal(compareOutcomes({ code: 2, output: `${ts}\n${ts.replace('(3,5)', '(9,1)')}` }, { code: 2, output: ts }).fresh.length, 1);
  // пути рабочих копий не мешают
  const wt = 'C:\\Users\\a\\p\\.agentyard\\worktrees\\T1-abc\\web\\src\\a.tsx(3,5): error TS2322: x';
  const base = 'C:\\Users\\a\\p\\.agentyard\\worktrees\\base-xyz\\web\\src\\a.tsx(3,5): error TS2322: x';
  assert.equal(compareOutcomes({ code: 2, output: wt }, { code: 2, output: base }).preexisting, true);
  // без узнаваемых ключей — по подписи вывода
  assert.equal(compareOutcomes({ code: 1, output: 'Segmentation fault 12 at 0x1' }, { code: 1, output: 'Segmentation fault 99 at 0x7' }).preexisting, true);
});

test('исходное состояние: каждая команда запускается один раз; после установки пакетов — заново', async () => {
  let runs = 0;
  const b = new BaselineRunner(async () => {
    runs++;
    return { code: 1, output: 'x' };
  });
  await Promise.all([b.of('cd "web" && tsc'), b.of('cd "web" && tsc'), b.of('go test')]);
  assert.equal(runs, 2);
  b.invalidate((c) => c.includes('cd "web"'));
  await b.of('cd "web" && tsc');
  await b.of('go test');
  assert.equal(runs, 3);
});

test('разбор неудачи: пакет, окружение, сбой модели, чужие файлы, свои', () => {
  assert.equal(packageOfSpecifier('@mantine/core/styles.css'), '@mantine/core');
  assert.equal(packageOfSpecifier('next/link'), 'next');
  assert.equal(packageOfSpecifier('./x'), null);
  assert.equal(packageOfSpecifier('@/shared/ui'), null);
  assert.equal(packageOfSpecifier('node:fs'), null);
  assert.equal(packageOfSpecifier('fs'), null);
  const layout = "import '@mantine/core/styles.css'\nimport { MantineProvider } from '@mantine/core'\nimport type { ReactNode } from 'react'\nimport Link from 'next/link'\n";
  assert.deepEqual(missingPackages(layout, new Set(['react', 'next'])), ['@mantine/core']);
  assert.deepEqual(missingFromOutput("app/layout.tsx(2,33): error TS2307: Cannot find module '@mantine/core' or its corresponding type declarations."), ['@mantine/core']);
  const ctx = { taskFiles: ['web/app/layout.tsx'], changedFiles: ['web/app/layout.tsx'], projectFiles: ['web/app/layout.tsx', 'web/src/features/audit-log-form/ui/AuditLogForm.tsx'] };
  assert.equal(triage('5:typecheck:x', "app/layout.tsx(2,33): error TS2307: Cannot find module '@mantine/core' or its corresponding type declarations.", ctx).env?.kind, 'missing-package');
  assert.equal(triage('6:tests:x', GO_RED, ctx).cls, 'environment');
  assert.equal(triage('agent:Модель не ответила за 300 с (/api/chat).', 'Модель не ответила за 300 с (/api/chat).', ctx).cls, 'infra');
  assert.equal(triage('format', 'нет JSON', ctx).cls, 'format');
  assert.equal(triage('5:typecheck:y', "src/features/audit-log-form/ui/AuditLogForm.tsx(32,82): error TS2322: Type 'A' is not assignable to type 'B'.", ctx).cls, 'collateral');
  assert.equal(triage('5:typecheck:z', "app/layout.tsx(7,3): error TS2322: Type 'A' is not assignable to type 'B'.", ctx).cls, 'own');
  assert.deepEqual(filesInOutput('web\\app\\layout.tsx(7,3): error', ['web/app/layout.tsx']), ['web/app/layout.tsx']);
});

test('политика: окружение чинит программа, сбой модели не тратит попытку, прогресс не поднимает лестницу, зацикливание — сразу выше', () => {
  const base = { ladderStep: 2, attempts: 1, maxAttempts: 5, canInstall: true };
  const own = (sig: string, stage: number, errors: number, patch?: string): AttemptLog => ({ sig, cls: 'own', stage, errors, patch, model: 'm1' });
  const tri = (cls: 'own' | 'infra' | 'format' | 'environment', env?: { kind: 'missing-package'; packages: string[]; detail: string }) => ({ cls, files: [], errors: 1, why: '', ...(env ? { env } : {}) });

  let d = decide({ ...base, history: [], now: { sig: '5:t', cls: 'environment', stage: 5, errors: 1 }, triage: tri('environment', { kind: 'missing-package', packages: ['@mantine/core'], detail: 'нет пакета' }) });
  assert.deepEqual(d.action === 'install' && d.packages, ['@mantine/core']);
  d = decide({ ...base, canInstall: false, history: [], now: { sig: '5:t', cls: 'environment', stage: 5, errors: 1 }, triage: tri('environment', { kind: 'missing-package', packages: ['@mantine/core'], detail: 'нет пакета' }) });
  assert.equal(d.action, 'human');
  assert.match(d.why, /npm install @mantine\/core/);

  d = decide({ ...base, history: [], now: { sig: 'agent:x', cls: 'infra', stage: 0, errors: 0, model: 'm1' }, triage: tri('infra') });
  assert.ok(d.action === 'retry' && !d.count && !d.otherModel);
  d = decide({ ...base, history: [{ sig: 'agent:x', cls: 'infra', stage: 0, errors: 0, model: 'm1' }], now: { sig: 'agent:x', cls: 'infra', stage: 0, errors: 0, model: 'm1' }, triage: tri('infra') });
  assert.ok(d.action === 'retry' && !d.count && d.otherModel);

  d = decide({ ...base, history: [{ sig: 'format', cls: 'format', stage: 0, errors: 0, model: 'm1' }], now: { sig: 'format', cls: 'format', stage: 0, errors: 0, model: 'm1' }, triage: tri('format') });
  assert.ok(d.action === 'retry' && d.otherModel, 'та же модель второй раз не по формату — другая');

  // прогресс: ошибок меньше — та же ступень, бюджет больше
  d = decide({ ...base, history: [own('5:a', 5, 4)], now: own('5:b', 5, 2), triage: tri('own') });
  assert.ok(d.action === 'retry' && d.stay && d.budget === 6, JSON.stringify(d));
  // упала дальше по проверкам — тоже прогресс
  d = decide({ ...base, history: [own('3:a', 3, 1)], now: own('6:b', 6, 1), triage: tri('own') });
  assert.ok(d.action === 'retry' && d.stay);
  // та же правка — сразу аналитик
  d = decide({ ...base, history: [own('5:a', 5, 2, 'p1')], now: own('5:c', 5, 3, 'p1'), triage: tri('own') });
  assert.ok(d.action === 'retry' && d.step === 3 && !d.stay);
  // та же ошибка снова — ступенью выше
  d = decide({ ...base, history: [own('5:a', 5, 2)], now: own('5:a', 5, 2), triage: tri('own') });
  assert.ok(d.action === 'retry' && d.step === 3);
});

test('цена смен: слабая загруженная модель уступает работу; пачка дешевле одиночки; прерывать эпоху — только если окупится', () => {
  const cat = loadCatalog();
  const weak = { ...cat.find((m) => m.ollamaTag === 'qwen3.5:4b')! };
  const strong = { ...cat.find((m) => m.ollamaTag === 'gpt-oss:20b')! };
  const team: Team = { models: [weak, strong], byRole: { coder: strong, reviewer: strong, planner: strong, analyst: strong, tester: strong, scout: weak, reporter: weak }, score: 1 };
  const ctx = { team, stats: new Stats(null), loadedModelId: weak.id, now: 0, fits: () => true };
  const task = { id: 'T1', title: 'x', brief: '', type: 'edit', dependsOn: [], files: ['a.ts'], accept: { tests: [], commands: [] }, size: 'S', role: 'coder', status: 'ready', weight: 1, attempts: 0, ladderStep: 0, failures: [], readySince: 0, frozenFiles: [] } as unknown as Task;
  const item = { task, role: 'coder' as const, kind: 'work' as const };
  assert.ok(ett(item, strong, ctx, 1) < ett(item, weak, ctx, 1), 'сильная со сменой быстрее слабой без смены');
  assert.ok(ett(item, strong, ctx, 5) < ett(item, strong, ctx, 1), 'цена смены делится на пачку');
  assert.ok(epochRate([item, item, item], strong, ctx) > epochRate([item], strong, ctx));
  assert.equal(worthInterrupting(5, 140, strong, weak, ctx), true);
  assert.equal(worthInterrupting(1, 10, strong, weak, ctx), false);
});
