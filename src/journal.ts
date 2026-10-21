// Журнал: машинный (события в JSONL) и человеческий (фразы по шаблонам, без нейросети).
// Отчёт собирается из журнала — поэтому в нём не может быть выдумок.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type JournalEvent =
  | { type: 'run-start'; goal: string; repo: string; tier: string; hardware: string; team: string[] }
  | { type: 'plan'; tasks: { id: string; title: string; type: string; dependsOn: string[] }[]; warnings: string[]; understanding?: string }
  | { type: 'context'; files: string[] }
  | { type: 'recipe'; names: string[] }
  | { type: 'resume'; done: number; left: number; human: number }
  | { type: 'install'; taskId: string; packages: string[]; ok: boolean; versions: Record<string, string>; seconds: number; output?: string; note?: string }
  | { type: 'human-fix'; taskId: string; ok: boolean; why: string }
  | { type: 'revived'; taskId: string }
  | { type: 'replicated'; taskId: string; example: string; applied: number; failed: number; skipped?: number; added: string[] }
  | { type: 'goal-check'; round: number; model: string; achieved: boolean | null; missing: string[]; added: string[]; seconds: number }
  | { type: 'baseline'; stage: string; command: string; passed: boolean; output?: string; known?: number }
  | { type: 'gpu-fallback'; model: string }
  | { type: 'gpu-back'; model: string }
  | { type: 'applied'; ok: boolean; message: string; files: number }
  | { type: 'model-failed'; model: string; error: string; attempt: number; final: boolean }
  | { type: 'swap'; from: string | null; to: string; ms: number }
  | { type: 'dispatch'; taskId: string; role: string; model: string; reason: string }
  | { type: 'agent-done'; taskId: string; role: string; model: string; ok: boolean; steps: number; files: string[]; note?: string; error?: string; seconds: number }
  | { type: 'checks'; taskId: string; passed: boolean; stage: number; stageName: string; seconds: number; output?: string }
  | { type: 'review'; taskId: string; model: string; verdict: string; reasons: string[]; coverage?: { requirement: string; check: string }[] }
  | { type: 'escalate'; taskId: string; step: number; what: string; attempt: number }
  | { type: 'split'; taskId: string; into: string[]; rethink?: boolean }
  | { type: 'self-help'; taskId: string; what: string }
  | { type: 'merged'; taskId: string; commit: string }
  | { type: 'conflict'; taskId: string }
  | { type: 'human'; taskId: string; why: string }
  | { type: 'full-suite'; passed: boolean; output?: string }
  | { type: 'bisect'; culprit: string | null; taskId?: string }
  | { type: 'run-end'; done: number; human: number; seconds: number; swaps: number }
  | { type: 'pool'; id: string; leader: string; members: string[]; glob?: string; where: string }
  | { type: 'pool-promote'; pool: string; from: string; to: string | null; why: string }
  | { type: 'tirage'; taskId: string; from: string; applied: string[]; skipped: number; failed: { file: string; why: string }[]; added: string[]; exact: boolean; done?: string[] }
  | { type: 'assembled'; taskId: string; parts: string[]; ok: boolean; why?: string; added?: string[] }
  | { type: 'review-vetted'; taskId: string; dropped: { reason: string; why: string }[]; approved: boolean }
  | { type: 'decision'; taskId: string; facts: string[] }
  | { type: 'learned'; taskId: string; section: string; title: string; fresh: boolean; file: string | null }
  | { type: 'learned-hit'; taskId: string; titles: string[]; sections: string[] }
  | { type: 'rework'; round: number; note: string; missing: string[]; added: string[]; error?: string }
  | { type: 'lookup'; taskId: string; local: boolean; query: string; hits: number; pages: number; urls?: string[] }
  | { type: 'stop'; active: string | null }
  | { type: 'triage'; taskId: string; cls: string; why: string; decision: string };

export interface Stamped { at: string; event: JournalEvent }

const STEP_NAMES: Record<number, string> = {
  1: 'ответ не по форме — повтор с текстом ошибки',
  2: 'снова кодер, с точным текстом ошибки',
  3: 'вторая пара глаз: аналитик уточняет бриф',
  4: 'дробление задачи на меньшие',
  5: 'позвать старшего: более сильная модель',
  6: 'нужен человек',
};

export function humanLine(e: JournalEvent): string {
  switch (e.type) {
    case 'run-start':
      return `Старт. Цель: «${e.goal}». Железо: ${e.hardware}, тир ${e.tier}. Бригада: ${e.team.join(' + ')}.`;
    case 'goal-check':
      if (e.achieved === true) return `Приёмка по цели (${e.model}): цель достигнута.`;
      if (e.achieved === null) return `Приёмка по цели не получилась (${e.model} не дал разборчивого ответа${e.missing.length ? `: ${e.missing.join('; ')}` : ''}) — результат по задачам.`;
      return `Приёмка по цели (${e.model}): цель НЕ достигнута — ${e.missing.join('; ') || 'без пояснений'}.${e.added.length ? ` Доделываю: ${e.added.join(', ')}.` : ' Задач на доработку не дано — смотри сам.'}`;
    case 'human-fix':
      return e.ok ? `${e.taskId}: ручная правка человека принята — ${e.why}. Агенты идут дальше по цепочке.` : `${e.taskId}: ручная правка пока не принята — ${e.why}`;
    case 'revived':
      return `${e.taskId}: блокер снят — задача снова в работе у агентов.`;
    case 'replicated':
      return `${e.taskId}: правка из ${e.example} повторена по образцу ещё в ${e.applied} файлах${e.skipped ? `; в ${e.skipped} такого фрагмента нет — там менять нечего` : ''}${e.failed ? `; в ${e.failed} не подошла — отдельные задачи ${e.added.join(', ')}` : ''}.`;
    case 'install':
      if (e.taskId === '—') return e.ok ? `После применения выполнен npm install в проекте: package.json и lock-файл в порядке.` : `npm install в проекте после применения не прошёл — выполни его сам. ${(e.output ?? '').split('\n').slice(-3).join(' ')}`;
      return e.ok
        ? `${e.taskId}: поставлены пакеты ${Object.entries(e.versions).map(([n, v]) => `${n}@${v}`).join(', ')} за ${e.seconds.toFixed(0)} с (в node_modules проекта, твой package.json не тронут до применения)${e.note ? `; ${e.note}` : ''}.`
        : `${e.taskId}: не получилось поставить ${e.packages.join(', ')}.`;
    case 'resume':
      return `Продолжаю прерванный прогон: сделано ${e.done}, осталось ${e.left}${e.human ? `, у человека ${e.human}` : ''}. Начатые задачи — заново от ветки сборки.`;
    case 'recipe':
      return `Беру проверенный рецепт для такой задачи: ${e.names.join(', ')} (skills/recipes).`;
    case 'context':
      return `Нашёл по словам цели, где это в коде: ${e.files.join(', ')}.`;
    case 'plan':
      return `${e.understanding ? `Понял цель так: ${e.understanding} ` : ''}План готов, задач: ${e.tasks.length}${e.warnings.length ? `; поправки: ${e.warnings.join('; ')}` : ''}.`;
    case 'baseline':
      if (e.passed) return `Исходное состояние: ${e.stage} (${e.command}) — зелёная, ступень работает.`;
      if (e.known) return `Исходное состояние: ${e.stage} (${e.command}) находит ${e.known} ошибок ещё до начала работы. Они запомнены: задача провалит эту ступень, только если добавит новые. Были: ${(e.output ?? '').split(/\r?\n/).slice(0, 3).join(' | ')}`;
      if (e.stage === 'тесты') return 'Исходное состояние: в проекте нет тестов — работу агентов программа проверит только синтаксисом и типами (если они есть) и ревью моделью.';
      return `Исходное состояние: ${e.stage} (${e.command}) падает ещё до начала работы — ступень отключена, иначе она завалила бы каждую задачу. Первая ошибка: ${(e.output ?? '').split(/\r?\n/).find((l) => l.trim()) ?? ''}`;
    case 'applied':
      return e.ok ? `Результат применён в проект. ${e.message}` : e.message;
    case 'gpu-back':
      return `Видеокарта снова грузит модели: ${e.model} — на ней.`;
    case 'gpu-fallback':
      return `Видеокарта не загружает модели (сбой CUDA в Ollama) — ${e.model} и следующие модели работают на процессоре. Это заметно медленнее; через 4 минуты попробую видеокарту снова. Если сбой повторяется — перезапусти Ollama.`;
    case 'model-failed':
      return e.final
        ? `Модель ${e.model} не загрузилась ни на видеокарту, ни на процессор — дальше работаю без неё. Ошибка Ollama: ${e.error}`
        : `Модель ${e.model} не загрузилась (попытка ${e.attempt}), Ollama сбоит — жду и пробую ещё раз. Ошибка: ${e.error}`;
    case 'swap':
      return `Смена модели: ${e.from ?? '—'} → ${e.to} за ${(e.ms / 1000).toFixed(1)} с.`;
    case 'dispatch':
      return `${roleRu(e.role)} (${e.model}) берёт задачу ${e.taskId}. Почему: ${e.reason}.`;
    case 'agent-done':
      return e.ok
        ? `${roleRu(e.role)} (${e.model}) сдал ${e.taskId} за ${e.seconds.toFixed(0)} с, ${e.steps} шагов${e.files.length ? `, файлы: ${e.files.join(', ')}` : ''}.${e.note ? ` «${e.note}»` : ''}`
        : `${roleRu(e.role)} (${e.model}) не справился с ${e.taskId}: ${e.error}`;
    case 'checks':
      return e.passed
        ? `Проверки ${e.taskId}: все ступени пройдены за ${e.seconds.toFixed(0)} с.`
        : `Проверки ${e.taskId}: провал на ступени ${e.stage} (${e.stageName}).`;
    case 'review':
      if (e.verdict === 'approve') return `Ревьюер (${e.model}) принял ${e.taskId}.${e.coverage ? ` Требований из цели: ${e.coverage.length}, у каждого есть проверка в тесте.` : ''}`;
      if (e.verdict === 'skipped' && e.model === '—') return `Ревью ${e.taskId} не нужно: ${e.reasons.join('; ')}.`;
      if (e.verdict === 'skipped') return `Ревью ${e.taskId} пропущено: ревьюер (${e.model}) не дал ответа (${e.reasons.join('; ')}). Все программные проверки зелёные — задача принимается.`;
      return `Ревьюер (${e.model}) вернул ${e.taskId}: ${e.reasons.join('; ')}.${e.coverage ? ` Покрыто требований: ${e.coverage.filter((c) => c.check.trim()).length} из ${e.coverage.length}.` : ''}`;
    case 'escalate':
      return `${e.taskId}: попытка ${e.attempt}, ступень ${e.step} — ${e.what || STEP_NAMES[e.step] || ''}.`;
    case 'split':
      return e.rethink ? `${e.taskId}: прежний подход не сработал — планировщик предложил другой: ${e.into.join(', ')}.` : `${e.taskId} разбита на ${e.into.join(', ')}.`;
    case 'self-help':
      return e.taskId === '—' ? `${e.what[0]!.toUpperCase()}${e.what.slice(1)}.` : `${e.taskId}: ${e.what}`;
    case 'merged':
      return `${e.taskId} влита в ветку сборки (коммит ${e.commit.slice(0, 8)}).`;
    case 'conflict':
      return `${e.taskId}: конфликт при слиянии — задача переделывается от свежей ветки.`;
    case 'human':
      return `${e.taskId} ждёт человека: ${e.why}`;
    case 'full-suite':
      return e.passed ? 'Полный набор тестов на ветке сборки — зелёный.' : 'Полный набор тестов на ветке сборки упал.';
    case 'bisect':
      return e.culprit ? `Поиск виновного: поломку внесла задача ${e.taskId} (коммит ${e.culprit.slice(0, 8)}), коммит откатан.` : 'Поиск виновного не нашёл одного коммита.';
    case 'pool':
      return `Классификатор: ${e.members.join(', ')} — одна и та же правка в однотипных файлах${e.glob ? ` (${e.glob})` : ''}. Пул ${e.id}: сначала образец ${e.leader}, остальные ждут его и получат готовое решение${e.where ? ` (${e.where})` : ''}.`;
    case 'pool-promote':
      return e.to
        ? `Пул ${e.pool}: образец ${e.from} не получился (${e.why}) — образцом становится ${e.to}, с учётом, на чём упал ${e.from}.`
        : `Пул ${e.pool}: и второй образец ${e.from} не получился (${e.why}) — остальные задачи пула не начинаю: та же правка, скорее всего, тоже не выйдет. Сделай образец руками — программа повторит его в остальных.`;
    case 'tirage': {
      if (!e.applied.length && !e.failed.length && !e.done?.length) return `${e.taskId}: в остальных файлах (${e.skipped}) повторять нечего — там нет того, что менялось в ${e.from}.`;
      const head = e.done?.length
        ? `${e.taskId}: решение из ${e.from} программа повторила в задачах ${e.done.join(', ')} — проверки пройдены, модель не понадобилась`
        : e.applied.length
          ? `${e.taskId}: решение из ${e.from} программа повторила ещё в ${e.applied.length} файл(ах) — проверки пройдены, модель не понадобилась`
          : `${e.taskId}: решение из ${e.from} программа повторить не смогла`;
      const skip = e.skipped ? `; в ${e.skipped} менять нечего` : '';
      const failWhat = e.done !== undefined ? 'задачах' : '';
      const fail = e.failed.length ? `; в ${e.failed.length} ${failWhat}${failWhat ? ' ' : ''}не подошло (${e.failed.slice(0, 3).map((f) => `${f.file.split('/').pop()}: ${f.why}`).join('; ')}${e.failed.length > 3 ? '; …' : ''})${e.done !== undefined ? ' — они пойдут к модели уже с решением, шагами и признаками готовности' : ''}` : '';
      const added = e.added.length ? ` — задачи ${e.added.join(', ')} с готовыми шагами` : '';
      return `${head}${skip}${fail}${added}.${e.exact ? '' : ' (Правила не воспроизвели образец точно — по ним только шаги для модели.)'}`;
    }
    case 'assembled':
      return e.ok
        ? `${e.taskId}: собрана из частей ${e.parts.join(', ')} — решения частей переданы наверх.`
        : `${e.taskId}: части ${e.parts.join(', ')} сделаны, но критерий задачи не проходит (${e.why ?? ''})${e.added?.length ? ` — добавлена часть ${e.added.join(', ')}` : ''}.`;
    case 'review-vetted':
      return `${e.taskId}: программа проверила причины ревью — ${e.dropped.map((d) => `«${d.reason.slice(0, 120)}» неверно: ${d.why}`).join('; ')}.${e.approved ? ' Других причин нет — задача принята.' : ''}`;
    case 'learned':
      return `${e.taskId}: ${e.fresh ? 'записал в копилку решений' : 'подтвердил решение в копилке'} — «${e.title}»${e.file ? ` (${e.file})` : ''}.`;
    case 'learned-hit':
      return e.taskId === '—'
        ? `Копилка решений: учту для плана — ${e.titles.map((x) => `«${x}»`).join(', ')}.`
        : `${e.taskId}: такую ошибку уже решали — беру из копилки решений: ${e.titles.map((x) => `«${x}»`).join(', ')}.`;
    case 'rework':
      if (!e.note && !e.missing.length) return 'Доработка: приёмка ничего не просила, а человек ничего не написал — доделывать нечего. Напиши, что поправить.';
      return `Доработка (раунд ${e.round})${e.note ? ` по просьбе человека: «${e.note}»` : ' по замечаниям приёмки'}${e.missing.length ? `; приёмка: ${e.missing.join('; ')}` : ''}. ${e.added.length ? `Задачи: ${e.added.join(', ')}.` : `Планировщик не дал задач${e.error ? ` (${e.error})` : ''}.`}`;
    case 'lookup': {
      const found = [e.local ? 'объявления типов в установленной библиотеке' : '', e.hits ? `в интернете ${e.hits} ссылок${e.pages ? `, выдержки с ${e.pages} страниц` : ''} (поиск «${e.query}»)` : e.query ? `в интернете ничего не нашлось (поиск «${e.query}»)` : ''].filter(Boolean);
      return `${e.taskId}: ошибка повторяется — программа поискала справку: ${found.length ? found.join('; ') : 'ничего не нашла'}${found.length ? '. Справка уйдёт исполнителю со следующей попыткой' : ''}.`;
    }
    case 'decision':
      return `${e.taskId}: принятые решения — ${e.facts.join('; ')}.`;
    case 'triage': {
      const CLS: Record<string, string> = { own: 'ошибка модели', collateral: 'правка задела другие файлы', environment: 'мешает окружение', format: 'ответ не по формату', infra: 'сбой модели или Ollama', review: 'вернул ревьюер', conflict: 'конфликт слияния' };
      return `${e.taskId}: разбор неудачи — ${CLS[e.cls] ?? e.cls} (${e.why}); дальше: ${e.decision}.`;
    }
    case 'stop':
      return `Человек нажал «Стоп»${e.active ? ` — запрос к модели по ${e.active} оборван` : ''}; идущие проверки доделываются, остальное уходит человеку.`;
    case 'run-end':
      return `Финиш за ${(e.seconds / 60).toFixed(1)} мин: готово ${e.done}, ждут человека ${e.human}, смен моделей ${e.swaps}.`;
  }
}

function roleRu(role: string): string {
  return (
    { coder: 'Кодер', tester: 'Тестировщик', reviewer: 'Ревьюер', analyst: 'Аналитик', planner: 'Планировщик', scout: 'Разведчик', reporter: 'Репортёр' } as Record<string, string>
  )[role] ?? role;
}

export class Journal {
  readonly dir: string;
  readonly events: Stamped[] = [];
  private quiet: boolean;
  /** Подписчик на живые записи (интерфейс). */
  onRecord?: (stamped: Stamped, line: string) => void;

  constructor(dir: string, quiet = false, onRecord?: (stamped: Stamped, line: string) => void) {
    this.dir = dir;
    this.quiet = quiet;
    this.onRecord = onRecord;
    mkdirSync(dir, { recursive: true });
    // продолжение прерванного прогона: прошлые события остаются в отчёте
    const prev = path.join(dir, 'events.jsonl');
    if (existsSync(prev)) {
      for (const l of readFileSync(prev, 'utf8').split('\n')) {
        try {
          if (l.trim()) this.events.push(JSON.parse(l) as Stamped);
        } catch {
          /* битая строка от упавшего процесса */
        }
      }
    }
  }

  record(event: JournalEvent): void {
    const at = new Date().toISOString();
    this.events.push({ at, event });
    appendFileSync(path.join(this.dir, 'events.jsonl'), `${JSON.stringify({ at, event })}\n`);
    const line = `${at.slice(11, 19)}  ${humanLine(event)}`;
    appendFileSync(path.join(this.dir, 'journal.txt'), `${line}\n`);
    if (!this.quiet) console.log(line);
    try {
      this.onRecord?.({ at, event }, line);
    } catch {
      /* интерфейс не должен ронять конвейер */
    }
  }

  /** Отчёт: Markdown и HTML (HTML открывается в браузере и печатается в PDF). */
  writeReport(summary: {
    goal: string;
    branch: string;
    done: string[];
    human: { id: string; why: string }[];
    commands: string[];
    changes?: { file: string; status: string; added: number; removed: number }[];
    applied?: { ok: boolean; message: string };
  }): string {
    const ev = this.events.map((s) => s.event);
    const end = ev.find((e) => e.type === 'run-end') as Extract<JournalEvent, { type: 'run-end' }> | undefined;
    const checks = ev.filter((e) => e.type === 'checks') as Extract<JournalEvent, { type: 'checks' }>[];
    const reviews = ev.filter((e) => e.type === 'review') as Extract<JournalEvent, { type: 'review' }>[];
    const agents = ev.filter((e) => e.type === 'agent-done') as Extract<JournalEvent, { type: 'agent-done' }>[];

    const lines: string[] = [];
    lines.push(`# Отчёт AgentYard`, '');
    lines.push('## Итог простыми словами', '');
    lines.push(`- Просили: ${summary.goal === 'fix-tests' ? 'починить падающие тесты' : summary.goal}`);
    lines.push(`- Сделано задач: ${summary.done.length}${summary.done.length ? ` (${summary.done.join(', ')})` : ''}`);
    lines.push(`- Ждут человека: ${summary.human.length}`);
    if (end) lines.push(`- Время: ${(end.seconds / 60).toFixed(1)} мин, смен моделей: ${end.swaps}`);
    if (summary.applied?.ok) lines.push(`- Результат уже применён в проект (ветка \`${summary.branch}\` влита в твою). Отменить — кнопкой «Отменить применение».`, '');
    else lines.push(`- Все изменения лежат в ветке \`${summary.branch}\`. Твоя ветка не тронута — примени результат кнопкой «Применить в проект».${summary.applied ? ` (${summary.applied.message})` : ''}`, '');
    if (summary.changes?.length) {
      lines.push('## Что изменено в проекте', '', '| Файл | Что | Строк + / − |', '| --- | --- | --- |');
      const ru: Record<string, string> = { added: 'новый', modified: 'изменён', deleted: 'удалён', renamed: 'переименован' };
      for (const c of summary.changes) lines.push(`| \`${c.file}\` | ${ru[c.status] ?? c.status} | +${c.added} / −${c.removed} |`);
      lines.push('');
    } else lines.push('Изменений в файлах проекта нет.', '');

    const goalChecks = ev.filter((e) => e.type === 'goal-check') as Extract<JournalEvent, { type: 'goal-check' }>[];
    const lastGoal = goalChecks.at(-1);
    if (lastGoal) {
      lines.push('## Цель достигнута?', '');
      lines.push(lastGoal.achieved === true ? `- Да — так считает приёмка (${lastGoal.model}), проверив итоговые изменения против цели.` : lastGoal.achieved === false ? `- Не полностью. Чего не хватает: ${lastGoal.missing.join('; ') || '—'}.` : '- Приёмка не дала ответа — оцени результат сам.');
      if (goalChecks.length > 1 || goalChecks.some((g) => g.added.length)) lines.push(`- Кругов доработки: ${goalChecks.filter((g) => g.added.length).length}.`);
      lines.push('');
    }

    lines.push('## Почему этому можно доверять', '');
    lines.push(`- Каждая принятая правка прошла каскад проверок. Успешных прогонов проверок: ${checks.filter((c) => c.passed).length}; провалов, вернувших задачу на доработку: ${checks.filter((c) => !c.passed).length}.`);
    lines.push(`- Ревью моделью: одобрено ${reviews.filter((r) => r.verdict === 'approve').length}, возвращено ${reviews.filter((r) => r.verdict === 'changes').length}, пропущено ${reviews.filter((r) => r.verdict === 'skipped').length}.`);
    lines.push('- Агенты работали только в отдельных рабочих копиях внутри папки проекта; пути за её пределы отклоняются программой.');
    lines.push('- Журнал ниже написан программой по шаблонам, а не нейросетью.', '');

    // куда ушло время: работа моделей, смены моделей, проверки
    const swaps = ev.filter((e) => e.type === 'swap') as Extract<JournalEvent, { type: 'swap' }>[];
    const byModel = new Map<string, { s: number; n: number; fails: number }>();
    for (const a of agents) {
      const cur = byModel.get(`${roleRu(a.role)} · ${a.model}`) ?? { s: 0, n: 0, fails: 0 };
      cur.s += a.seconds;
      cur.n += 1;
      if (!a.ok) cur.fails += 1;
      byModel.set(`${roleRu(a.role)} · ${a.model}`, cur);
    }
    const agentSec = agents.reduce((x, a) => x + a.seconds, 0);
    const swapSec = swaps.reduce((x, s) => x + s.ms / 1000, 0);
    const checkSec = checks.reduce((x, c) => x + c.seconds, 0);
    const failSec = agents.filter((a) => !a.ok).reduce((x, a) => x + a.seconds, 0);
    lines.push('## Куда ушло время', '');
    lines.push('| Что | Секунд | Комментарий |', '| --- | --- | --- |');
    lines.push(`| Работа моделей | ${agentSec.toFixed(0)} | из них на неудачные попытки: ${failSec.toFixed(0)} |`);
    lines.push(`| Смены моделей | ${swapSec.toFixed(0)} | смен: ${swaps.length} |`);
    lines.push(`| Проверки | ${checkSec.toFixed(0)} | идут параллельно с работой модели |`);
    if (end) lines.push(`| Всего | ${end.seconds.toFixed(0)} | |`);
    lines.push('', '| Роль · модель | Вызовов | Секунд | Неудач |', '| --- | --- | --- | --- |');
    for (const [k, v] of [...byModel].sort((a, b) => b[1].s - a[1].s)) lines.push(`| ${k} | ${v.n} | ${v.s.toFixed(0)} | ${v.fails} |`);
    lines.push('');

    const covered = reviews.filter((r) => r.verdict === 'approve' && r.coverage?.length);
    if (covered.length) {
      lines.push('## Какие требования проверяют тесты', '');
      for (const r of covered) {
        lines.push(`Задача ${r.taskId} (проверил ${r.model}):`, '', '| Требование | Строка теста |', '| --- | --- |');
        for (const c of r.coverage!) lines.push(`| ${c.requirement.replace(/\|/g, '/')} | \`${c.check.replace(/\|/g, '/').replace(/`/g, "'")}\` |`);
        lines.push('');
      }
    }

    if (summary.human.length) {
      lines.push('## Что осталось на человеке', '');
      for (const h of summary.human) lines.push(`- ${h.id}: ${h.why}`);
      lines.push('');
    }

    lines.push('## Кто что делал', '', '| Задача | Роль | Модель | Шаги | Результат |', '| --- | --- | --- | --- | --- |');
    for (const a of agents) lines.push(`| ${a.taskId} | ${roleRu(a.role)} | ${a.model} | ${a.steps} | ${a.ok ? 'сдал' : `ошибка: ${(a.error ?? '').replace(/\|/g, '/')}`} |`);
    lines.push('');

    if (summary.commands.length) {
      lines.push('## Выполненные команды проверок', '');
      for (const c of [...new Set(summary.commands)]) lines.push(`- \`${c}\``);
      lines.push('');
    }

    lines.push('## Журнал', '', '```text');
    for (const s of this.events) lines.push(`${s.at.slice(11, 19)}  ${humanLine(s.event)}`);
    lines.push('```', '');

    const md = lines.join('\n');
    writeFileSync(path.join(this.dir, 'report.md'), md);
    writeFileSync(path.join(this.dir, 'report.html'), markdownToHtml(md));
    return path.join(this.dir, 'report.html');
  }
}

/** Мини-конвертер Markdown → HTML для отчёта (заголовки, списки, таблицы, код). */
export function markdownToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
  const out: string[] = [];
  const lines = md.split('\n');
  let inCode = false;
  let inList = false;
  let table: string[][] | null = null;

  const flushTable = () => {
    if (!table) return;
    const [head, , ...rows] = table;
    out.push('<table><thead><tr>' + head!.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
    for (const r of rows) out.push('<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
    out.push('</tbody></table>');
    table = null;
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) out.push('</pre>');
      else out.push('<pre>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(esc(line));
      continue;
    }
    if (line.startsWith('|')) {
      table ??= [];
      table.push(line.split('|').slice(1, -1).map((c) => c.trim()));
      continue;
    }
    flushTable();
    if (line.startsWith('- ')) {
      if (!inList) out.push('<ul>');
      inList = true;
      out.push(`<li>${inline(line.slice(2))}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    const h = /^(#{1,3}) (.*)$/.exec(line);
    if (h) out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  flushTable();
  if (inList) out.push('</ul>');

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Отчёт AgentYard</title>
<style>
body{font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:860px;margin:32px auto;padding:0 16px;color:#1d1d1b}
h1{font-size:26px}h2{font-size:19px;margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:4px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f4f4f2}pre{background:#f6f6f4;padding:12px;white-space:pre-wrap;font-size:12.5px;border-radius:6px}
code{background:#f0f0ee;padding:1px 4px;border-radius:3px}
@media print{body{margin:0}}
</style></head><body>
${out.join('\n')}
</body></html>`;
}
