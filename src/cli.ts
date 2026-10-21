#!/usr/bin/env node
// Командная строка AgentYard (этап 0).
//   ay hw                       — замер железа и тир
//   ay models [pull <тег>]      — каталог моделей: что влезет, что скачано
//   ay demo [папка]             — создать учебный репозиторий
//   ay run --repo <папка> --goal "<цель>" | fix-tests [опции]

import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { probeHardware, TIER_TEXT } from './hardware.ts';
import { loadCatalog, findByTag } from './catalog.ts';
import { fitsMemory, isMoE, kvCacheGb } from './team.ts';
import { Stats } from './stats.ts';
import { OllamaRuntime } from './runtime/ollama.ts';
import { Pipeline } from './pipeline.ts';
import { createDemoRepo, createFeatureRepo, demoRuntime, featureRuntime, FEATURE_GOAL } from './demo.ts';
import { ensureRepo, gitScope, isRepo, hasUncommitted } from './git.ts';
import { AGENT } from './config.ts';
import type { Plan } from './types.ts';

const HELP = `AgentYard — конвейер локальных агентов (этап 0, без интерфейса)

Команды:
  hw                         замерить железо и показать тир
  models                     каталог: какие модели влезут и какие уже скачаны
  models pull <тег>          скачать модель через Ollama
  demo [папка]               создать учебный репозиторий с двумя ошибками
  demo-shop [папка]          создать учебный магазин (цель — добавить промокоды)
  run --repo <папка> --goal "<цель>"   запустить конвейер
  ui [--port N] [--no-open]  открыть интерфейс (доска, журнал, отчёт) в браузере
  eval [--only a,b]          «пьяный тест»: небрежные просьбы на учебных проектах, оценка программой
  resume <папка> <id прогона> продолжить прерванный прогон (окно закрылось, компьютер уснул)
  apply <папка> <id прогона> влить результат прогона в текущую ветку проекта (undo — отменить)

Опции run:
  --goal fix-tests           особая цель: починить падающие тесты (план без модели)
  --goal shop-demo           цель для учебного магазина: добавить промокоды с тестами
  --plan <файл.json>         взять готовый план вместо планировщика
  --no-review                без ревью моделью
  --offload                  разрешить модели частично жить в оперативке (медленнее)
  --ctx <токенов>            длина контекста (по умолчанию ${AGENT.defaultContext})
  --init-git                 если папка не под git — создать репозиторий
  --yes                      не спрашивать подтверждение плана
  --apply                    сразу влить результат в текущую ветку, если всё готово
  --allow-install            разрешить ставить пакеты npm, которые просит план
  --mock                     учебная модель вместо Ollama (только для demo-репозитория)
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'hw':
      return cmdHw();
    case 'models':
      return cmdModels(rest);
    case 'demo':
      return cmdDemo(rest[0] ?? 'agentyard-demo');
    case 'demo-shop': {
      const abs = path.resolve(rest[0] ?? 'agentyard-shop');
      createFeatureRepo(abs);
      console.log(`Учебный магазин создан: ${abs}`);
      console.log(`Цель: ${FEATURE_GOAL}`);
      console.log(`Запуск: ay run --repo "${abs}" --goal shop-demo`);
      return;
    }
    case 'run':
      return cmdRun(rest);
    case 'ui':
      return cmdUi(rest);
    case 'eval':
      return cmdEval(rest);
    case 'resume': {
      const [dir, id] = rest;
      if (!dir || !id) {
        console.log('ay resume <папка> <id прогона>');
        return;
      }
      const { readRunState } = await import('./pipeline.ts');
      const st = readRunState(path.join(path.resolve(dir), '.agentyard', 'runs', id));
      if (!st) throw new Error('Этот прогон нельзя продолжить: он прервался до начала работы.');
      return cmdRun(['--repo', dir, '--goal', st.goal, '--yes', '--resume-id', id, ...rest.slice(2)]);
    }
    case 'apply': {
      const { applyRun, unapplyRun } = await import('./apply.ts');
      const [dir, id, undo] = rest;
      if (!dir || !id) {
        console.log('ay apply <папка> <id прогона> [undo]');
        return;
      }
      const r = undo === 'undo' ? await unapplyRun(path.resolve(dir), id) : await applyRun(path.resolve(dir), id);
      console.log(r.message);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    default:
      console.log(HELP);
  }
}

async function cmdHw(): Promise<void> {
  const hw = await probeHardware();
  console.log(`Видеокарта:   ${hw.gpuName ?? 'не найдена'}`);
  console.log(`Видеопамять:  ${hw.vramTotalGb} ГБ (свободно ${hw.vramFreeGb} ГБ)`);
  console.log(`Оперативка:   ${hw.ramTotalGb} ГБ (свободно ${hw.ramFreeGb} ГБ)`);
  console.log(`Ядер:         ${hw.cpuCores}`);
  console.log(`\nТир ${hw.tier}. ${TIER_TEXT[hw.tier]}`);
}

async function cmdModels(rest: string[]): Promise<void> {
  const ollama = new OllamaRuntime();
  if (rest[0] === 'pull' && rest[1]) {
    let last = '';
    await ollama.pull(rest[1], (t) => {
      if (t !== last) process.stdout.write(`\r${t.padEnd(40)}`);
      last = t;
    });
    console.log(`\nГотово: ${rest[1]}`);
    return;
  }
  const hw = await probeHardware();
  const catalog = loadCatalog();
  const online = await ollama.ping();
  const installed = online ? await ollama.listInstalled() : [];
  console.log(`Тир ${hw.tier}: ${hw.vramTotalGb} ГБ видеопамяти, ${hw.ramTotalGb} ГБ RAM. Ollama: ${online ? 'работает' : 'не отвечает (запусти ollama serve)'}\n`);
  console.log('Модель                         ГБ с контекстом  Влезет             Скачана  Кодер  Ревьюер');
  for (const m of catalog) {
    const fit = fitsMemory(m, hw, AGENT.defaultContext)
      ? 'да'
      : fitsMemory(m, hw, AGENT.defaultContext, true)
        ? isMoE(m)
          ? 'да, часть в RAM'
          : 'с --offload'
        : 'нет';
    const have = installed.some((i) => findByTag(catalog, i.tag)?.id === m.id) ? 'да' : '—';
    const gb = Math.round((m.memoryGbQ4 + kvCacheGb(AGENT.defaultContext)) * 10) / 10;
    const f = (r: 'coder' | 'reviewer') => (m.roles[r] ?? 0).toFixed(2);
    const tag = m.legacy ? `${m.ollamaTag} (старая)` : m.ollamaTag;
    console.log(`${tag.padEnd(30)} ${String(gb).padEnd(16)} ${fit.padEnd(18)} ${have.padEnd(8)} ${f('coder').padEnd(6)} ${f('reviewer')}`);
  }
  console.log('\nКодер и Ревьюер — стартовая оценка пригодности к роли (0–1); дальше её уточняет статистика на твоём железе.');
  console.log('Скачать: ay models pull <тег>');
}

async function cmdDemo(dir: string): Promise<void> {
  const abs = path.resolve(dir);
  createDemoRepo(abs);
  console.log(`Учебный репозиторий создан: ${abs}`);
  console.log(`Запуск на учебной модели:  ay run --repo "${abs}" --goal fix-tests --mock --yes`);
  console.log(`Запуск на Ollama:          ay run --repo "${abs}" --goal fix-tests`);
}

async function cmdRun(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      goal: { type: 'string' },
      plan: { type: 'string' },
      'no-review': { type: 'boolean', default: false },
      offload: { type: 'boolean', default: false },
      ctx: { type: 'string' },
      'init-git': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      mock: { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      'allow-install': { type: 'boolean', default: false },
      'resume-id': { type: 'string' },
    },
  });
  if (!values.repo || (!values.goal && !values.plan)) {
    console.log(HELP);
    process.exitCode = 1;
    return;
  }
  let repo = path.resolve(values.repo);
  if (values.goal === 'shop-demo') values.goal = FEATURE_GOAL;

  if (!(await isRepo(repo))) {
    if (!values['init-git']) {
      throw new Error('Папка не под git. Конвейер работает в отдельной ветке, чтобы всё можно было откатить. Добавь --init-git, и я создам репозиторий.');
    }
    await ensureRepo(repo);
    console.log('Создан git-репозиторий с исходным состоянием проекта.');
  }
  const scope = await gitScope(repo);
  if (scope) {
    console.log(`Папка ${scope.focus}/ — часть git-репозитория ${scope.root}: работаю от его корня, правки — в ${scope.focus}/.`);
    repo = scope.root;
  }
  if (await hasUncommitted(repo)) {
    console.log('Внимание: в проекте есть незакоммиченные изменения — конвейер возьмёт за основу последний коммит.\n');
  }

  const runtime = values.mock ? (values.goal === FEATURE_GOAL ? featureRuntime() : demoRuntime()) : new OllamaRuntime();
  if (!values.mock && !(await (runtime as OllamaRuntime).ping())) {
    throw new Error('Ollama не отвечает на 127.0.0.1:11434. Запусти Ollama (или используй --mock для учебного прогона).');
  }

  const hardware = await probeHardware();
  // учебной модели всё равно, какое железо: считаем, что всё помещается
  if (values.mock) Object.assign(hardware, { gpuName: 'учебный режим', tier: 'T3', vramTotalGb: 48, vramFreeGb: 48 });

  const pipeline = new Pipeline({
    repo,
    focus: scope?.focus,
    goal: values.goal ?? 'План из файла',
    learnedDir: values.mock ? null : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'learned'),
    runtime,
    catalog: loadCatalog(),
    hardware,
    stats: new Stats(values.mock ? null : undefined),
    planFile: values.plan,
    review: !values['no-review'],
    allowOffload: values.offload,
    numCtx: values.ctx ? Number(values.ctx) : AGENT.defaultContext,
    approvePlan: values.yes ? undefined : askApproval,
    autoApply: values.apply,
    allowInstall: values['allow-install'],
    runId: values['resume-id'],
    resume: !!values['resume-id'],
  });

  // Ctrl+C: первый раз — «Стоп» (прогон доделывает идущее и выгружает модели из видеопамяти), второй — выйти сразу
  let interrupts = 0;
  const onInterrupt = () => {
    if (++interrupts > 1) process.exit(130);
    console.log('\nОстанавливаю прогон и выгружаю модели… (ещё раз Ctrl+C — выйти сразу)');
    pipeline.stop();
  };
  process.on('SIGINT', onInterrupt);
  const res = await pipeline.run().finally(() => process.off('SIGINT', onInterrupt));
  console.log('\n— Итог —');
  console.log(`Готово: ${res.done.length} · ждут человека: ${res.human.length} · смен моделей: ${res.swaps} · ${(res.seconds / 60).toFixed(1)} мин`);
  console.log(`Ветка с изменениями: ${res.branch}`);
  for (const c of res.changes) console.log(`  ${c.status.padEnd(9)} ${c.file}  +${c.added} −${c.removed}`);
  if (res.applied) console.log(res.applied.message);
  else if (res.changes.length) console.log(`Применить в проект: ay apply "${repo}" ${path.basename(res.runDir)}`);
  console.log(`Отчёт: ${res.reportPath}  (открой в браузере, Ctrl+P → «Сохранить как PDF»)`);
}

async function cmdEval(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { only: { type: 'string' }, ctx: { type: 'string' } } });
  const { runEval, renderEval } = await import('./eval.ts');
  const runtime = new OllamaRuntime();
  if (!(await runtime.ping())) throw new Error('Ollama не отвечает на 127.0.0.1:11434 — экзамен идёт на настоящих моделях.');
  const hardware = await probeHardware();
  const stats = new Stats();
  const started = new Date();
  const root = path.resolve('eval-runs', started.toISOString().replace(/[-:T]/g, '').slice(0, 14));
  let models = '';
  const rows = await runEval(
    root,
    async (repo, goal) => {
      const res = await new Pipeline({
        repo,
        goal,
        runtime,
        catalog: loadCatalog(),
        hardware: { ...hardware },
        stats,
        numCtx: values.ctx ? Number(values.ctx) : AGENT.defaultContext,
        quiet: true,
        autoApply: true,
        allowInstall: true,
      }).run();
      const journal = (await import('node:fs')).readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
      models ||= /Бригада: (.+)\.$/m.exec(journal)?.[1] ?? '';
      return res;
    },
    values.only?.split(',').map((s) => s.trim()).filter(Boolean),
    (s) => console.log(s),
  );
  const md = renderEval(rows, { models, started: started.toLocaleString('ru-RU') });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(root, 'eval.md'), md);
  writeFileSync(path.join(root, 'eval.json'), JSON.stringify(rows, null, 2));
  const { appendHistory, trendText } = await import('./eval.ts');
  const history = appendHistory(path.dirname(root), {
    at: started.toISOString(),
    models,
    passed: rows.filter((r) => r.pass).length,
    total: rows.length,
    dir: root,
    rows: rows.map((r) => ({ id: r.id, pass: r.pass, seconds: Math.round(r.seconds) })),
  });
  console.log(`\nСдано ${rows.filter((r) => r.pass).length} из ${rows.length}. ${trendText(history)}\nОтчёт: ${path.join(root, 'eval.md')}`);
}

async function cmdUi(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { port: { type: 'string' }, 'no-open': { type: 'boolean', default: false }, ready: { type: 'boolean', default: false } } });
  const { startServer } = await import('./server.ts');
  const srv = await startServer({ port: values.port ? Number(values.port) : 0 });
  // строка для Electron-оболочки: по ней она узнаёт адрес
  if (values.ready) console.log(`AY_READY ${JSON.stringify({ url: srv.url })}`);
  console.log(`Интерфейс AgentYard: ${srv.url}`);
  console.log('Окно консоли не закрывай — это и есть сервер. Остановить: Ctrl+C.');
  // выход по Ctrl+C или закрытию окна консоли: остановить идущий прогон, чтобы он выгрузил модели из видеопамяти
  let leaving = false;
  const leave = () => {
    if (leaving) process.exit(130);
    leaving = true;
    console.log('Останавливаю прогон и выгружаю модели…');
    srv.shutdown().finally(() => process.exit(0));
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, leave);
  if (!values['no-open']) {
    const { spawn } = await import('node:child_process');
    const opener = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', srv.url]] : process.platform === 'darwin' ? ['open', [srv.url]] : ['xdg-open', [srv.url]];
    spawn(opener[0] as string, opener[1] as string[], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  }
}

async function askApproval(plan: Plan, warnings: string[]): Promise<boolean> {
  console.log('\nПлан:');
  if (plan.understanding) console.log(`  Понял так: ${plan.understanding}`);
  for (const t of plan.tasks) {
    const deps = t.dependsOn.length ? ` (после ${t.dependsOn.join(', ')})` : '';
    console.log(`  ${t.id} [${t.type}] ${t.title}${deps}`);
    console.log(`      файлы: ${t.files.join(', ') || '—'}${t.similar ? ` (+ по образцу: ${t.similar})` : ''}; критерий: ${[...t.accept.tests, ...t.accept.commands].join(', ') || '—'}`);
    if (t.install?.length) console.log(`      поставит пакеты npm: ${t.install.join(', ')}`);
  }
  for (const w of warnings) console.log(`  ! ${w}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('\nЗапускаем? [y/N] ')).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'д' || answer === 'yes' || answer === 'да';
}

main().catch((e: Error) => {
  console.error(`\nОшибка: ${e.message}`);
  process.exitCode = 1;
});
