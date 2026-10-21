// Уровень 4. Выполнение задачи агентом.
// Агент = роль (инструкция из SKILL.md) + модель + инструменты + цикл с лимитами.
// Порядок частей запроса постоянный: инструкция роли → карта проекта → задача → код → ошибки.

import { checkCoverage, type CoverageItem } from './coverage.ts';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT, CHECKS } from './config.ts';
import { listDir, readFile, search, truncate } from './tools/fs.ts';
import { applyPatches, REWRITE_MAX_LINES } from './tools/patch.ts';
import { templateRegex } from './replicate.ts';
import { langOf as stackLang } from './stacks.ts';
import { extractText } from './engine/extract.ts';
import { extractToolCalls, jsonObjectsIn, normalizePatches, stripLineNumbers } from './tools/shim.ts';
import type { ChatMessage, ChatRequest, Runtime, ToolDef } from './runtime/types.ts';
import type { Patch, Role, Task } from './types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(here, '..', 'skills');

export interface AgentInput {
  task: Task;
  role: Role;
  modelTag: string;
  /** Как модель рассуждает (из каталога): нужно, чтобы правильно выключить рассуждения. */
  thinking?: 'toggle' | 'levels';
  workdir: string;
  repoMapText: string;
  maxSteps: number;
  numCtx: number;
  /** Для ревью: изменения, которые надо оценить. */
  diff?: string;
  /** Прямой режим: ответ одним JSON по схеме, без инструментов. */
  direct?: boolean;
  /** Исходная цель человека дословно — чтобы требования не терялись в пересказе планировщика. */
  goal?: string;
  /** Что агент делает прямо сейчас — для живой строки в окне («читает файл…», «думает, шаг 2»). */
  onActivity?: (text: string) => void;
  /** Контекст матрёшки и пула — его собирает программа (см. decisions.ts). */
  context?: TaskContext;
  /** Своя температура: варианты правки на повторе (несколько ответов той же модели — программа берёт прошедший проверки). */
  temperature?: number;
}

export interface TaskContext {
  /** Где задача в общей работе: часть чего, кто делает остальное. */
  scope?: string;
  /** Уже принятые решения других задач (факты по diff). */
  decisions?: string;
  /** Принятое решение-образец (diff), которое задача повторяет. */
  solution?: string;
  /** Как другая задача уже справилась с той же ошибкой. */
  fix?: string;
  /** Для ревьюера: что программа уже проверила (типы, признаки готовности). */
  verified?: string[];
  /** Для ревьюера: небольшие изменённые файлы целиком — видно импорты вне diff. */
  files?: { file: string; text: string }[];
}

const DOING: Partial<Record<Role, string>> = { coder: 'пишет правку', tester: 'пишет тест', reviewer: 'смотрит правку', analyst: 'разбирает ошибку', planner: 'составляет план' };

/** Ход генерации простыми словами: «пишет ответ: 340 токенов, 10.7 т/с». */
export function progressText(doing: string, p: import('./runtime/types.ts').ChatProgress): string {
  if (p.phase === 'prompt') return `${doing}: модель читает задачу (${Math.round(p.seconds)} с)`;
  const speed = p.tps ? `, ${p.tps.toFixed(1)} ток/с` : '';
  return `${doing}: ${p.phase === 'thinking' ? 'рассуждает' : 'пишет ответ'} — ${p.tokens} ток.${speed}`;
}

function say(input: AgentInput, text: string): void {
  try {
    input.onActivity?.(text);
  } catch {
    /* окно не должно ронять агента */
  }
}

export interface AgentResult {
  ok: boolean;
  patches?: Patch[];
  changedFiles: string[];
  changedLines: number;
  review?: { verdict: 'approve' | 'changes'; reasons: string[]; coverage?: CoverageItem[] };
  brief?: { brief: string; files: string[] };
  note?: string;
  /** Файлы, которых не было в задаче, но правка их потребовала (программа разрешила и добавила). */
  addedFiles?: string[];
  error?: string;
  /** Модель не смогла ответить по форме — ступень 1 лестницы. */
  formatFailure?: boolean;
  steps: number;
  promptTokens: number;
  outputTokens: number;
  promptMs: number;
  genMs: number;
  log: string[];
  /** Полная переписка с моделью — для разбора неудач. */
  transcript: ChatMessage[];
  /** Сколько раз пришлось доставать вызов инструмента из текста. */
  shimmed: number;
}

// ---------- инструменты ----------

const T = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

const TOOL_LIST_DIR = T('list_dir', 'Список файлов и папок. Путь относительно корня проекта.', { path: { type: 'string' } }, ['path']);
const TOOL_READ = T(
  'read_file',
  'Прочитать файл с номерами строк. Можно указать диапазон строк.',
  { path: { type: 'string' }, from: { type: 'integer' }, to: { type: 'integer' } },
  ['path'],
);
const TOOL_SEARCH = T('search', 'Найти строку или регулярное выражение во всех файлах проекта.', { pattern: { type: 'string' } }, ['pattern']);

const PATCH_ITEM = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'Путь к файлу от корня проекта' },
    search: { type: 'string', description: 'Точный фрагмент из файла, который заменить. Пустая строка — создать новый файл.' },
    replace: { type: 'string', description: 'Новый текст на месте фрагмента' },
    all: { type: 'boolean', description: 'true — заменить КАЖДОЕ вхождение фрагмента в файле (одинаковые теги, классы: <th> → <Table.Th>). По умолчанию фрагмент должен встречаться ровно один раз.' },
  },
  required: ['file', 'search', 'replace'],
};
const TOOL_SUBMIT_PATCHES = T(
  'submit_patches',
  'Сдать работу: список заплаток «найди — замени». Вызывай, когда изменения готовы.',
  { patches: { type: 'array', items: PATCH_ITEM }, note: { type: 'string', description: 'Что изменено и зачем, одной-двумя фразами' } },
  ['patches', 'note'],
);
const TOOL_SUBMIT_REVIEW = T(
  'submit_review',
  'Сдать ревью: approve — изменения выполняют задачу; changes — нужно доработать, с причинами.',
  { verdict: { type: 'string', enum: ['approve', 'changes'] }, reasons: { type: 'array', items: { type: 'string' } } },
  ['verdict', 'reasons'],
);
const TOOL_SUBMIT_BRIEF = T(
  'submit_brief',
  'Сдать уточнённый бриф: что именно и где менять.',
  { brief: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } },
  ['brief', 'files'],
);

const ROLE_TOOLS: Partial<Record<Role, ToolDef[]>> = {
  coder: [TOOL_LIST_DIR, TOOL_READ, TOOL_SEARCH, TOOL_SUBMIT_PATCHES],
  tester: [TOOL_LIST_DIR, TOOL_READ, TOOL_SEARCH, TOOL_SUBMIT_PATCHES],
  analyst: [TOOL_LIST_DIR, TOOL_READ, TOOL_SEARCH, TOOL_SUBMIT_BRIEF],
  reviewer: [TOOL_READ, TOOL_SEARCH, TOOL_SUBMIT_REVIEW],
};

const SUBMIT_TOOL: Partial<Record<Role, string>> = {
  coder: 'submit_patches',
  tester: 'submit_patches',
  analyst: 'submit_brief',
  reviewer: 'submit_review',
};

/** Памятки по языкам файлов задачи (skills/lang/*.md): частые ошибки маленьких моделей в этом языке. Не больше двух. */
export function languageNotes(files: string[]): string[] {
  const langs = [...new Set(files.map((f) => stackLang(f)).filter((x): x is string => !!x))].slice(0, 2);
  return langs.map((l) => path.join(SKILLS_DIR, 'lang', `${l}.md`)).filter((f) => existsSync(f)).map((f) => readFileSync(f, 'utf8').trim());
}

export function loadSkill(role: Role): string {
  const file = path.join(SKILLS_DIR, role, 'SKILL.md');
  return existsSync(file) ? readFileSync(file, 'utf8') : `Ты — ${role}. Выполни задачу и сдай результат инструментом.`;
}

// ---------- сборка контекста (решает программа, а не модель) ----------

/** Сколько символов исходных материалов помещается в запрос (остальное — задача, шаги, ответ). */
export function inputBudget(numCtx: number): number {
  return Math.max(4000, Math.floor(numCtx * 1.3));
}

function inputsSection(inputs: string[], workdir: string, budget: number): string[] {
  const out: string[] = ['## Исходные материалы (прочитай внимательно: результат — только по ним, ничего не выдумывай)'];
  let left = budget;
  for (const f of inputs) {
    const abs = path.isAbsolute(f) ? f : path.join(workdir, f);
    const ex = existsSync(abs) ? extractText(abs) : null;
    const name = path.isAbsolute(f) ? path.basename(f) : f;
    if (!ex) {
      out.push(`### ${name}
(файл не найден или формат не читается)`);
      continue;
    }
    const text = ex.text.length > left ? `${ex.text.slice(0, left)}\n… (дальше обрезано)` : ex.text;
    left -= Math.min(left, ex.text.length);
    out.push(`### ${name} (${ex.how}${ex.note ? `; ${ex.note}` : ''})\n${text}`);
    if (left <= 0) break;
  }
  return out;
}

export function buildTaskPrompt(input: AgentInput): string {
  const { task, workdir } = input;
  const parts: string[] = [];
  parts.push('## Карта проекта', input.repoMapText);
  if (input.goal) parts.push('## Общая цель (дословно от человека — требования отсюда важнее пересказа ниже)', input.goal);
  parts.push('## Задача', `${task.id}: ${task.title}`, task.brief);
  // задача не про код: исходные документы и данные — текстом (docx, pdf, xlsx… программа прочитала сама)
  if (task.inputs?.length) parts.push(...inputsSection(task.inputs, workdir, inputBudget(input.numCtx)));
  const ctx = input.context;
  if (ctx?.scope) parts.push('## Место задачи в общей работе', ctx.scope);
  if (ctx?.decisions) parts.push('## Уже принятые решения (опирайся на них, не переделывай и не противоречь им)', ctx.decisions);
  if (ctx?.solution && input.role !== 'reviewer') parts.push('## Решение-образец (принято и влито — сделай так же в своём файле)', '```diff\n' + truncate(ctx.solution, 3500) + '\n```');
  if (task.steps?.length && input.role !== 'reviewer') parts.push('## Шаги (делай по порядку)', task.steps.map((x, i) => `${i + 1}. ${x}`).join('\n'));
  if (task.doneWhen?.length && input.role !== 'reviewer') {
    parts.push(
      '## Готово, когда (это проверит программа)',
      task.doneWhen
        .map((d) => `- ${d.file}: ${[d.lacks?.length ? `не осталось ${d.lacks.map((m) => `\`${m}\``).join(', ')}` : '', d.has?.length ? `есть ${d.has.map((m) => `\`${m}\``).join(', ')}` : ''].filter(Boolean).join('; ')}`)
        .join('\n'),
    );
  }
  // подсказка человека — главное: он посмотрел, на чём споткнулись, и написал, как надо
  if (task.humanHint && input.role !== 'reviewer') parts.push('## Подсказка человека (это главное — сделай именно так; если там код, вставь его, поправив только имена под этот файл)', truncate(task.humanHint, 6000));
  if (ctx?.fix && input.role !== 'reviewer') parts.push('## Такая же ошибка уже решена в другой задаче', ctx.fix);
  if (task.reference && input.role !== 'reviewer') parts.push('## Справка по ошибке (нашла программа: объявления типов установленных библиотек и поиск в интернете — опирайся на неё, а не на память)', truncate(task.reference, 6000));
  if (task.type === 'test') {
    parts.push(
      '## Важно про эту задачу',
      'Режим «сначала тест»: код для этого поведения ещё НЕ написан — его сделает следующая задача. Тест обязан падать сейчас, в том числе из-за того, что функции или файла ещё нет. Это нормально.',
      'Полнота: на КАЖДОЕ требование из общей цели — своя проверка с конкретными значениями. Обычный случай и каждая граница проверяются отдельно (например, «минус 500» и «не ниже нуля» — две разные проверки с разными числами). Каждое значение и текст ошибки из цели должны встретиться в тесте.',
    );
    const example = exampleTest(workdir, task);
    if (example) parts.push(`## Пример теста этого проекта (${example.file}) — пиши в том же стиле, теми же импортами и тем же тест-раннером`, '```js\n' + example.text + '\n```');
  }
  if (task.similar && input.role === 'coder') {
    parts.push(
      '## Правка по образцу',
      `Правь ТОЛЬКО ${task.files[0]}. Ту же правку программа повторит во всех файлах по шаблону ${task.similar}. Поэтому меняй так, чтобы правка подошла и остальным: бери в search общие для всех файлов строки (классы, разметку), а не то, что есть только в этом файле.`,
    );
  }
  if (task.wholeFile && (input.role === 'coder' || input.role === 'tester')) {
    const small = task.files.filter((f) => existsSync(path.join(workdir, f)) && readFileSync(path.join(workdir, f), 'utf8').split('\n').length <= REWRITE_MAX_LINES);
    if (small.length) {
      parts.push(
        '## Как сдать правку в этот раз',
        `Прошлые заплатки «найди — замени» не попадали в текст файла. Поэтому файлы ${small.join(', ')} присылай ЦЕЛИКОМ: search — пустая строка, replace — весь новый текст файла от первой до последней строки, без сокращений, «…» и «остальное без изменений». Всё, что не нужно менять, перепиши как было.`,
      );
    }
  }
  if (input.role !== 'analyst') {
    const notes = languageNotes([...task.files, ...task.accept.tests]);
    if (notes.length) parts.push('## Памятка по языку', notes.join('\n\n'));
  }
  if (task.type === 'edit' && input.role !== 'reviewer') {
    const missing = task.files.filter((f) => !existsSync(path.join(workdir, f)));
    const example = missing.length ? exampleSource(workdir, missing[0]!) : null;
    if (example) parts.push(`## Пример кода этого проекта (${example.file}) — новый файл пиши в том же стиле: те же import/export`, '```js\n' + example.text + '\n```');
  }
  parts.push(
    '## Критерий готовности',
    [
      ...task.accept.tests.map((t) => `- тест ${t} должен ${task.type === 'test' ? 'УПАСТЬ на текущем коде (он проверяет ещё не сделанное поведение)' : 'пройти'}`),
      ...task.accept.commands.map((c) => `- команда \`${c}\` должна завершиться успешно`),
    ].join('\n'),
  );

  if (input.role === 'reviewer') {
    if (task.type === 'test') {
      parts.push(
        '## Как ревьюить эту задачу',
        'Это тест в режиме «сначала тест»: реализации ещё нет, и это нормально — её напишет следующая задача. НЕ требуй реализацию. Твоя работа — проверить ПОЛНОТУ: разбей общую цель на отдельные требования (каждое значение, каждый текст ошибки, обычный случай и каждая граница) и для каждого найди строку теста, которая его проверяет. Требование без проверки — причина вернуть тест.',
      );
    }
    if (ctx?.verified?.length) parts.push('## Уже проверено программой (это факты — не оспаривай их)', ctx.verified.map((v) => `- ${v}`).join('\n'));
    parts.push('## Изменения для ревью', input.diff ?? '(нет изменений)');
    for (const f of ctx?.files ?? []) parts.push(`## Файл ${f.file} целиком после правки (для справки: импорты и остальное вне diff)`, `\`\`\`${langOf(f.file)}\n${f.text}${f.text.endsWith('\n') ? '' : '\n'}\`\`\``);
    if (ctx?.scope) parts.push('## Как ревьюить часть', 'Оценивай только эту задачу и её файлы. Не требуй правок в файлах, которых нет в задаче: их делают другие задачи или программа.');
  } else {
    const filesToShow = [...new Set([...task.files, ...task.accept.tests])];
    for (const f of filesToShow) {
      const abs = path.join(workdir, f);
      if (!existsSync(abs)) {
        parts.push(`## Файл ${f}`, '(файла пока нет — его нужно создать)');
        continue;
      }
      const frozen = task.frozenFiles.includes(f) ? ' (ЗАМОРОЖЕН — менять нельзя)' : '';
      // без номеров строк: модели путают «   5| » с отступом и ломают заплатки
      const text = truncate(readFileSync(abs, 'utf8').replace(/\r\n/g, '\n'), 12_000);
      parts.push(`## Файл ${f}${frozen}`, `\`\`\`${langOf(f)}\n${text}${text.endsWith('\n') ? '' : '\n'}\`\`\``);
    }
  }

  if (task.lastError) {
    parts.push('## Прошлая попытка не прошла проверку', truncate(task.lastError, 4_000));
    if (task.lastPatch?.length) parts.push('## Твоя прошлая заплатка (уже отменена)', JSON.stringify(task.lastPatch, null, 2));
  }
  if (input.direct) {
    const hint = input.role === 'reviewer' && task.type === 'test' ? TEST_REVIEW_HINT : DIRECT_HINT[input.role];
    parts.push('## Как сдать работу', hint ?? 'Верни JSON строго по схеме.');
  } else {
    const submit = SUBMIT_TOOL[input.role];
    parts.push('## Как сдать работу', `Когда готово — вызови инструмент ${submit}. Отвечай только вызовами инструментов.`);
  }
  return parts.join('\n\n');
}

/** Существующий тест проекта как образец стиля (самый короткий, чтобы не раздувать запрос). */
export function exampleTest(workdir: string, task: Task): { file: string; text: string } | null {
  const own = new Set(task.files);
  const candidates: { file: string; text: string }[] = [];
  const walk = (dir: string, rel: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const abs = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, r);
      else if (/(\.|_)(test|spec)\.(m?[jt]s|py)$|^test_.*\.py$/.test(name) && !own.has(r)) candidates.push({ file: r, text: readFileSync(abs, 'utf8') });
    }
  };
  walk(workdir, '');
  candidates.sort((a, b) => a.text.length - b.text.length);
  const best = candidates[0];
  return best ? { file: best.file, text: truncate(best.text, 3000) } : null;
}

/** Существующий файл кода рядом с новым — как образец стиля модулей и оформления. */
export function exampleSource(workdir: string, newFile: string): { file: string; text: string } | null {
  const ext = path.extname(newFile);
  if (!/^\.(m?[jt]s|py)$/.test(ext)) return null;
  const isTest = (n: string) => /(\.|_)(test|spec)\.\w+$|^test_/.test(n);
  const pick = (dirRel: string): { file: string; text: string } | null => {
    const dir = path.join(workdir, dirRel);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
    const c = readdirSync(dir)
      .filter((n) => path.extname(n) === ext && !isTest(n) && statSync(path.join(dir, n)).isFile())
      .map((n) => ({ file: dirRel ? `${dirRel}/${n}` : n, text: readFileSync(path.join(dir, n), 'utf8') }))
      .sort((a, b) => a.text.length - b.text.length);
    return c[0] ?? null;
  };
  const own = path.posix.dirname(newFile.split(path.sep).join('/'));
  const best = pick(own === '.' ? '' : own) ?? pick('src') ?? pick('lib') ?? pick('');
  return best ? { file: best.file, text: truncate(best.text, 2500) } : null;
}

function langOf(f: string): string {
  const ext = path.extname(f).slice(1).toLowerCase();
  return ({ js: 'js', mjs: 'js', cjs: 'js', ts: 'ts', tsx: 'tsx', jsx: 'jsx', py: 'python', json: 'json', md: 'markdown' } as Record<string, string>)[ext] ?? '';
}

// ---------- прямой режим: один ответ строго по бланку ----------

const PATCHES_SCHEMA = {
  type: 'object',
  required: ['patches', 'note'],
  properties: {
    patches: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['file', 'search', 'replace'],
        properties: { file: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' }, all: { type: 'boolean' } },
      },
    },
    note: { type: 'string' },
  },
};
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict', 'reasons'],
  properties: { verdict: { type: 'string', enum: ['approve', 'changes'] }, reasons: { type: 'array', items: { type: 'string' } } },
};
/** Ревью теста: список требований цели и строка теста, которая проверяет каждое. */
const TEST_REVIEW_SCHEMA = {
  type: 'object',
  required: ['requirements', 'verdict', 'reasons'],
  properties: {
    requirements: {
      type: 'array',
      minItems: 1,
      items: { type: 'object', required: ['requirement', 'check'], properties: { requirement: { type: 'string' }, check: { type: 'string' } } },
    },
    verdict: { type: 'string', enum: ['approve', 'changes'] },
    reasons: { type: 'array', items: { type: 'string' } },
  },
};
const TEST_REVIEW_HINT =
  'Верни JSON: {"requirements": [{"requirement": "одно требование из общей цели", "check": "строка из теста ДОСЛОВНО, которая его проверяет, или пустая строка"}], "verdict": "approve" или "changes", "reasons": [...]}. ' +
  'Выпиши КАЖДОЕ требование отдельно: обычный случай и каждая граница — разные требования (например, «скидка 500» и «не ниже нуля» — два требования, и для каждого нужна своя проверка с конкретными числами). ' +
  'check копируй из теста символ в символ — программа проверит, что такая строка там есть. Если проверки нет — check пустой, verdict "changes".';

const BRIEF_SCHEMA = {
  type: 'object',
  required: ['brief', 'files'],
  properties: { brief: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } },
};

const DIRECT_SCHEMA: Partial<Record<Role, Record<string, unknown>>> = {
  coder: PATCHES_SCHEMA,
  tester: PATCHES_SCHEMA,
  reviewer: REVIEW_SCHEMA,
  analyst: BRIEF_SCHEMA,
};

const DIRECT_HINT: Partial<Record<Role, string>> = {
  coder:
    'Верни JSON: {"patches": [{"file": "путь", "search": "точный фрагмент из файла выше, с теми же отступами", "replace": "новый текст"}], "note": "что сделано"}. Фрагмент search должен встречаться в файле ровно один раз — бери 1–3 строки целиком. Чтобы переписать небольшой файл ЦЕЛИКОМ — оставь search пустым, а в replace положи весь новый текст файла (старое содержимое будет заменено полностью).',
  tester:
    'Верни JSON: {"patches": [{"file": "путь к тесту", "search": "", "replace": "весь текст нового файла"}], "note": "что проверяет тест"}. Для правки существующего файла в search — точный фрагмент из него.',
  reviewer: 'Верни JSON: {"verdict": "approve" или "changes", "reasons": ["конкретная причина", …]}. Для approve reasons может быть пустым.',
  analyst: 'Верни JSON: {"brief": "что именно и где изменить, 3–6 предложений", "files": ["файлы, которые нужно править"]}.',
};

/**
 * Прямой режим: всё нужное уже в запросе, инструменты для поиска не нужны.
 * Модель отвечает одним JSON по схеме (рантайм не даёт отклониться),
 * при ошибке применения — до трёх быстрых поправок в том же разговоре.
 */
export async function runDirect(runtime: Runtime, input: AgentInput, maxFixes = 3): Promise<AgentResult> {
  const testReview = input.role === 'reviewer' && input.task.type === 'test';
  const schema = testReview ? TEST_REVIEW_SCHEMA : DIRECT_SCHEMA[input.role];
  const submitName = SUBMIT_TOOL[input.role];
  if (!schema || !submitName) throw new Error(`Роль ${input.role} не поддерживает прямой режим`);
  const messages: ChatMessage[] = [
    { role: 'system', content: loadSkill(input.role) },
    { role: 'user', content: buildTaskPrompt({ ...input, direct: true }) },
  ];
  const res: AgentResult = { ok: false, changedFiles: [], changedLines: 0, steps: 0, promptTokens: 0, outputTokens: 0, promptMs: 0, genMs: 0, log: [], transcript: messages, shimmed: 0 };

  for (let attempt = 0; attempt <= maxFixes; attempt++) {
    res.steps += 1;
    say(input, attempt === 0 ? `${DOING[input.role] ?? 'работает'}: модель думает` : `${DOING[input.role] ?? 'работает'}: исправляет ответ, попытка ${attempt + 1}`);
    const r = await runtime.chat({
      model: input.modelTag,
      messages,
      format: schema,
      temperature: input.temperature ?? (input.role === 'analyst' ? AGENT.temperaturePlan : AGENT.temperatureCode),
      numCtx: input.numCtx,
      think: thinkFor(input.role, input.thinking),
      maxTokens: AGENT.maxTokens[input.role],
      onProgress: input.onActivity ? (p) => say(input, progressText(DOING[input.role] ?? 'работает', p)) : undefined,
    });
    res.promptTokens += r.promptTokens;
    res.outputTokens += r.outputTokens;
    res.promptMs += r.promptMs;
    res.genMs += r.genMs;
    messages.push(r.message);

    let args: Record<string, unknown> | null = null;
    const parsed = jsonObjectsIn(r.message.content)[0];
    if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
    if (!args) {
      res.log.push(`шаг ${res.steps}: ответ не JSON${r.truncated ? ' (оборван по лимиту длины)' : ''}`);
      if (r.truncated) return { ...res, error: 'Ответ оборван по лимиту длины.', formatFailure: true };
      messages.push({ role: 'user', content: 'Ответ — не JSON. Верни JSON строго по схеме.' });
      continue;
    }
    // модель повторяет тот же ответ после замечания — дальше спрашивать бесполезно
    const prev = messages.filter((m) => m.role === 'assistant').slice(-2, -1)[0];
    if (prev && prev.content.trim() === r.message.content.trim()) {
      res.log.push(`шаг ${res.steps}: повтор того же ответа — прекращаю`);
      return { ...res, error: res.error ?? 'Модель повторила тот же ответ.' };
    }
    const outcome = handleSubmit(input, submitName, args);
    if (outcome.done) return { ...res, ...outcome.result, ok: true };
    res.log.push(`шаг ${res.steps}: сдача отклонена — ${outcome.message.split('\n')[1] ?? outcome.message.split('\n')[0]}`);
    say(input, `правка не легла: ${(outcome.message.split('\n')[1] ?? outcome.message.split('\n')[0] ?? '').slice(0, 140)}`);
    res.error = outcome.message;
    messages.push({ role: 'user', content: `${outcome.message}\nИсправь и верни JSON заново.` });
  }
  return { ...res, error: res.error ?? 'Модель не дала годного ответа.', formatFailure: !res.error };
}

/** Можно ли делать задачу в прямом режиме: всё, что нужно менять, известно и показано. */
export function canGoDirect(role: Role, task: Task, workdir: string): boolean {
  if (!AGENT.directMode || !DIRECT_SCHEMA[role]) return false;
  if (role === 'reviewer' || role === 'analyst') return true;
  const editable = task.files.filter((f) => !task.frozenFiles.includes(f));
  if (editable.length === 0) return false;
  const newFiles = new Set(task.newFiles ?? []);
  return editable.every((f) => newFiles.has(f) || role === 'tester' || existsSync(path.join(workdir, f)));
}

// ---------- цикл агента ----------

export async function runAgent(runtime: Runtime, input: AgentInput): Promise<AgentResult> {
  const tools = ROLE_TOOLS[input.role];
  const submitName = SUBMIT_TOOL[input.role];
  if (!tools || !submitName) throw new Error(`Роль ${input.role} не работает через цикл агента`);

  const messages: ChatMessage[] = [
    { role: 'system', content: loadSkill(input.role) },
    { role: 'user', content: buildTaskPrompt(input) },
  ];
  const res: AgentResult = { ok: false, changedFiles: [], changedLines: 0, steps: 0, promptTokens: 0, outputTokens: 0, promptMs: 0, genMs: 0, log: [], transcript: messages, shimmed: 0 };
  const seenCalls = new Map<string, number>();
  let noToolReplies = 0;
  let badSubmits = 0;

  while (res.steps < input.maxSteps) {
    res.steps += 1;
    say(input, `${DOING[input.role] ?? 'работает'}: модель думает (шаг ${res.steps} из ${input.maxSteps})`);
    const r = await runtime.chat({
      model: input.modelTag,
      messages,
      tools,
      temperature: input.temperature ?? (input.role === 'reviewer' || input.role === 'coder' || input.role === 'tester' ? AGENT.temperatureCode : AGENT.temperaturePlan),
      numCtx: input.numCtx,
      think: thinkFor(input.role, input.thinking),
      maxTokens: AGENT.maxTokens[input.role],
      onProgress: input.onActivity ? (p) => say(input, progressText(DOING[input.role] ?? 'работает', p)) : undefined,
    });
    res.promptTokens += r.promptTokens;
    res.outputTokens += r.outputTokens;
    res.promptMs += r.promptMs;
    res.genMs += r.genMs;
    messages.push(r.message);

    let calls = r.message.tool_calls ?? [];
    if (calls.length === 0 && r.message.content) {
      // прокладка: вызов инструмента записан текстом
      calls = extractToolCalls(r.message.content, tools.map((t) => t.function.name), submitName);
      if (calls.length) {
        res.shimmed += 1;
        res.log.push(`шаг ${res.steps}: вызов инструмента найден в тексте ответа`);
      }
    }
    if (calls.length === 0) {
      noToolReplies += 1;
      res.log.push(`шаг ${res.steps}: ответ без вызова инструмента${r.truncated ? ' (оборван по лимиту длины)' : ''}`);
      if (r.truncated && !r.message.content.trim()) {
        // модель ушла в долгие рассуждения и не дала ответа — второй шанс бесполезен
        return { ...res, error: 'Модель рассуждала до лимита длины и не дала ответа.', formatFailure: true };
      }
      if (noToolReplies >= 2) {
        return { ...res, error: 'Модель дважды ответила текстом вместо вызова инструмента.', formatFailure: true };
      }
      messages.push({ role: 'user', content: `Отвечай вызовом инструмента. Чтобы сдать работу, вызови ${submitName}.` });
      continue;
    }

    for (const call of calls) {
      const name = call.function.name;
      const args = normalizeArgs(call.function.arguments);

      if (name === submitName) {
        const outcome = handleSubmit(input, name, args);
        if (outcome.done) {
          return { ...res, ...outcome.result, ok: true, steps: res.steps };
        }
        badSubmits += 1;
        res.log.push(`шаг ${res.steps}: сдача отклонена — ${outcome.message.split('\n')[0]}`);
        say(input, `сдача отклонена: ${(outcome.message.split('\n')[0] ?? '').slice(0, 140)}`);
        if (badSubmits >= 3) return { ...res, error: outcome.message, formatFailure: true };
        messages.push({ role: 'tool', tool_name: name, content: outcome.message });
        continue;
      }

      // детектор петли: тот же вызов с теми же аргументами
      const key = `${name}:${JSON.stringify(args)}`;
      const seen = (seenCalls.get(key) ?? 0) + 1;
      seenCalls.set(key, seen);
      let output: string;
      if (seen === 3) {
        return { ...res, error: `Агент зациклился на вызове ${name}.` };
      } else if (seen === 2) {
        output = `Ты уже вызывал ${name} с этими аргументами, результат выше. Двигайся дальше или сдай работу через ${submitName}.`;
      } else {
        say(input, name === 'read_file' ? `читает файл ${String(args.path ?? '')}` : name === 'search' ? `ищет в проекте «${String(args.pattern ?? '').slice(0, 60)}»` : name === 'list_dir' ? `смотрит папку ${String(args.path ?? '.')}` : name);
        output = executeTool(input.workdir, name, args, tools);
      }
      res.log.push(`шаг ${res.steps}: ${name}(${shortArgs(args)})`);
      messages.push({ role: 'tool', tool_name: name, content: truncate(output, AGENT.toolOutputChars) });
    }
  }
  return { ...res, error: `Лимит шагов (${input.maxSteps}) исчерпан без сдачи работы.` };
}

/** Исполнителям рассуждения выключаем (или ставим минимальные): они долгие, а задача маленькая. */
export function thinkFor(role: Role, kind?: 'toggle' | 'levels'): ChatRequest['think'] {
  if (!kind) return undefined;
  const allowed = AGENT.thinkingRoles.includes(role);
  if (kind === 'levels') return allowed ? 'medium' : 'low';
  return allowed;
}

function executeTool(root: string, name: string, args: Record<string, unknown>, allowed: ToolDef[]): string {
  if (!allowed.some((t) => t.function.name === name)) return `Инструмента ${name} у этой роли нет.`;
  try {
    switch (name) {
      case 'list_dir':
        return listDir(root, String(args.path ?? '.'));
      case 'read_file':
        return readFile(root, String(args.path), num(args.from) ?? 1, num(args.to));
      case 'search':
        return search(root, String(args.pattern ?? ''));
      default:
        return `Неизвестный инструмент ${name}.`;
    }
  } catch (e) {
    return `Ошибка: ${(e as Error).message}`;
  }
}

/**
 * Ревью теста: программа проверяет, что цитаты действительно из теста, и сама добавляет причины,
 * если какое-то требование или значение из цели осталось без проверки.
 */
function reviewTestCoverage(input: AgentInput, args: Record<string, unknown>, verdict: 'approve' | 'changes', reasons: string[]): SubmitOutcome {
  const raw = Array.isArray(args.requirements) ? args.requirements : [];
  const items: CoverageItem[] = raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({ requirement: String(x.requirement ?? '').trim(), check: String(x.check ?? '') }))
    .filter((x) => x.requirement);
  if (items.length === 0) return { done: false, message: 'Список requirements пуст: выпиши каждое требование из общей цели и строку теста, которая его проверяет.' };
  const files = input.task.accept.tests.length ? input.task.accept.tests : input.task.files;
  const testText = files
    .map((f) => path.join(input.workdir, f))
    .filter((f) => existsSync(f))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
  const cov = checkCoverage(items, testText, input.goal);
  if (cov.badQuotes.length) {
    return {
      done: false,
      message: `Этих строк нет в тесте — скопируй check из теста дословно или оставь пустым, если проверки нет:\n${cov.badQuotes.map((q) => `- ${q}`).join('\n')}`,
    };
  }
  const extra = [
    ...cov.uncovered.map((r) => `Нет проверки для требования: ${r}`),
    ...cov.missingLiterals.map((l) => `В тесте не встречается значение из цели: «${l}»`),
  ];
  const finalReasons = [...reasons, ...extra.filter((e) => !reasons.includes(e))];
  const finalVerdict = extra.length ? 'changes' : verdict;
  if (finalVerdict === 'changes' && finalReasons.length === 0) return { done: false, message: 'Для changes укажи хотя бы одну причину в reasons.' };
  return { done: true, result: { review: { verdict: finalVerdict, reasons: finalReasons, coverage: items } } };
}

type SubmitOutcome = { done: true; result: Partial<AgentResult> } | { done: false; message: string };

function handleSubmit(input: AgentInput, name: string, args: Record<string, unknown>): SubmitOutcome {
  if (name === 'submit_review') {
    const verdict = args.verdict === 'approve' ? 'approve' : args.verdict === 'changes' ? 'changes' : null;
    if (!verdict) return { done: false, message: 'verdict должен быть approve или changes.' };
    const reasons = Array.isArray(args.reasons) ? args.reasons.map(String) : [];
    if (input.task.type === 'test' && input.role === 'reviewer') return reviewTestCoverage(input, args, verdict, reasons);
    if (verdict === 'changes' && reasons.length === 0) return { done: false, message: 'Для changes укажи хотя бы одну причину в reasons.' };
    return { done: true, result: { review: { verdict, reasons } } };
  }
  if (name === 'submit_brief') {
    const brief = String(args.brief ?? '').trim();
    if (!brief) return { done: false, message: 'brief пустой.' };
    const files = Array.isArray(args.files) ? args.files.map(String) : [];
    return { done: true, result: { brief: { brief, files } } };
  }

  // submit_patches
  const patches: Patch[] = normalizePatches(args).map((p) => ({ ...p, search: stripLineNumbers(p.search), replace: stripLineNumbers(p.replace) }));
  let addedFiles: string[] | undefined;
  if (patches.length === 0) {
    return {
      done: false,
      message:
        'Список patches пуст или в неверной форме. Нужно: {"patches": [{"file": "src/a.js", "search": "точный старый фрагмент", "replace": "новый фрагмент"}], "note": "что сделано"}',
    };
  }

  // тестировщик правит только тестовые файлы своей задачи
  if (input.role === 'tester') {
    const outside = patches.filter((p) => !input.task.files.includes(p.file.replace(/\\/g, '/')));
    if (outside.length) {
      return { done: false, message: `Тестировщик может менять только файлы: ${input.task.files.join(', ')}.` };
    }
  }

  // кодер правит файлы своей задачи. Один-два соседних файла (забытый импорт, стиль, конфиг) — разрешаем сами:
  // планировщик не всегда угадывает все места, а возвращать работу из-за этого — терять попытку
  if (input.role === 'coder') {
    const norm = (f: string) => f.replace(/\\/g, '/').replace(/^\.\//, '');
    const allowed = new Set([...input.task.files, ...(input.task.newFiles ?? [])].map(norm));
    const outside = [...new Set(patches.map((p) => norm(p.file)).filter((f) => !allowed.has(f)))];
    if (allowed.size && outside.length) {
      const why = extraFileProblem(input, outside);
      if (why) return { done: false, message: why };
      input.task.files.push(...outside);
      addedFiles = outside;
    }
  }

  const overwritable = [...(input.task.createdHere ?? []), ...(input.task.newFiles ?? [])];
  const applied = applyPatches(input.workdir, patches, input.task.frozenFiles, overwritable);
  if (!applied.ok) {
    // ступень 1 каскада: заплатка не применилась — модель правит только заплатку
    return { done: false, message: `Заплатки не применены, файлы не изменены:\n${applied.errors.join('\n')}` };
  }
  return {
    done: true,
    result: { patches, changedFiles: applied.changedFiles, changedLines: applied.changedLines, note: String(args.note ?? ''), addedFiles },
  };
}

/** Можно ли кодеру тронуть файлы вне задачи. null — можно (программа добавит их в задачу), иначе — почему нет. */
function extraFileProblem(input: AgentInput, outside: string[]): string | null {
  const t = input.task;
  const list = [...new Set([...t.files, ...(t.newFiles ?? [])])].join(', ');
  if (t.similar) {
    const re = templateRegex(t.similar);
    if (outside.some((f) => re.test(f))) return `Правь только образец ${t.files[0]}: в остальных файлах по шаблону ${t.similar} ту же правку программа сделает сама. Убери заплатки для: ${outside.join(', ')}.`;
  }
  const frozen = outside.filter((f) => t.frozenFiles.includes(f));
  if (frozen.length) return `Файлы ${frozen.join(', ')} заморожены (это тесты) — их менять нельзя, правь код.`;
  const forbidden = outside.filter((f) => CHECKS.forbidden.some((re) => re.test(f)));
  if (forbidden.length) return `Файлы ${forbidden.join(', ')} менять нельзя. Убери заплатки для них.`;
  if (t.install?.length && outside.some((f) => /(^|\/)package\.json$/.test(f))) return 'package.json не трогай: пакеты задачи программа уже поставила и сама допишет их в package.json. Убери заплатку для package.json.';
  if (outside.length > 2) return `Менять можно файлы задачи (${list}) и не больше двух соседних. Ты трогаешь ещё ${outside.length}: ${outside.join(', ')}. Делай только свою часть.`;
  return null;
}

/** Некоторые модели присылают аргументы строкой JSON. */
function normalizeArgs(a: unknown): Record<string, unknown> {
  if (typeof a === 'string') {
    try {
      return JSON.parse(a) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (a as Record<string, unknown>) ?? {};
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function shortArgs(a: Record<string, unknown>): string {
  return Object.entries(a)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 40) : JSON.stringify(v)?.slice(0, 40)}`)
    .join(', ');
}
