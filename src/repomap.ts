// Разведка без модели: структура проекта, сигнатуры, команды тестов и линтера.
// Это «оглавление» проекта — модель получает его вместо целых файлов.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { listFiles } from './tools/fs.ts';
import { projectDependencies } from './install.ts';
import { combinedCommands, detectStacks, type Stack } from './stacks.ts';

export interface ProjectCommands {
  /** Полный набор тестов. */
  test: string | null;
  /** Шаблон запуска одного тестового файла: {files} заменяется списком. */
  testFiles: string | null;
  lint: string | null;
  typecheck: string | null;
}

export interface RepoMap {
  languages: string[];
  files: string[];
  /** Короткие сигнатуры: файл → экспортируемые функции/классы. */
  symbols: Record<string, string[]>;
  testFiles: string[];
  commands: ProjectCommands;
  /** Как в проекте подключаются модули (только JS): esm — import/export, cjs — require/module.exports. */
  moduleSystem: 'esm' | 'cjs' | null;
  /** Пакеты из package.json (dependencies + devDependencies). */
  dependencies?: string[];
  /** Чем запускаются тесты (по скрипту test и импортам тестов). */
  testRunner: string | null;
  /** Подпроекты и их стеки (Go в backend/, Next во frontend/…). */
  stacks?: Stack[];
  /** Языки, фреймворки и пакеты — по ним подбираются рецепты. */
  tags?: string[];
}

const SIGNATURE_PATTERNS: Record<string, RegExp[]> = {
  js: [
    /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(([^)]*)\)/,
    /^\s*export\s+(?:default\s+)?class\s+(\w+)/,
    /^\s*export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/,
    /^\s*(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/,
    /^\s*module\.exports\.(\w+)\s*=/,
    /^\s*export\s+(?:interface|type)\s+(\w+)/,
  ],
  py: [/^\s*(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/, /^\s*class\s+(\w+)/],
  go: [/^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(([^)]*)\)/, /^type\s+(\w+)\s+(?:struct|interface)/],
  rs: [/^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/, /^\s*pub\s+(?:struct|enum|trait)\s+(\w+)/],
  java: [
    /^\s*(?:public\s+|protected\s+|internal\s+)?(?:abstract\s+|sealed\s+|static\s+|final\s+|partial\s+)*(?:class|interface|enum|record)\s+(\w+)/,
    /^\s*(?:public|protected|internal)\s+(?:static\s+|async\s+|override\s+|virtual\s+|final\s+|synchronized\s+)*[\w<>\[\],.?]+\s+(\w+)\s*\(([^)]*)\)/,
  ],
  kt: [
    /^\s*(?:(?:public|internal|private|abstract|sealed|data|open|enum)\s+)*(?:class|interface|object)\s+(\w+)/,
    /^\s*(?:(?:public|internal|override|suspend|open|inline)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)\s*\(([^)]*)\)/,
  ],
  php: [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+(\w+)/, /^\s*(?:public\s+|protected\s+)?(?:static\s+)?function\s+(\w+)\s*\(([^)]*)\)/],
  rb: [/^\s*(?:class|module)\s+([\w:]+)/, /^\s*def\s+(?:self\.)?(\w+[?!]?)(?:\(([^)]*)\))?/],
};

const LANG_NAME: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', py: 'Python', go: 'Go', rs: 'Rust',
  java: 'Java', kt: 'Kotlin', cs: 'C#', php: 'PHP', rb: 'Ruby', vue: 'Vue', svelte: 'Svelte', sql: 'SQL',
};
const SIG_OF: Record<string, string> = { ts: 'js', tsx: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', py: 'py', go: 'go', rs: 'rs', java: 'java', cs: 'java', kt: 'kt', php: 'php', rb: 'rb' };

export function buildRepoMap(root: string): RepoMap {
  const files = listFiles(root);
  const languages = new Set<string>();
  const symbols: Record<string, string[]> = {};

  for (const f of files) {
    const ext = path.extname(f).slice(1).toLowerCase();
    if (LANG_NAME[ext]) languages.add(LANG_NAME[ext]!);
    const lang = SIG_OF[ext];
    if (!lang) continue;
    const found: string[] = [];
    for (const line of readFileSync(path.join(root, f), 'utf8').split(/\r?\n/)) {
      for (const re of SIGNATURE_PATTERNS[lang]!) {
        const m = re.exec(line);
        if (m) {
          found.push(m[2] !== undefined ? `${m[1]}(${m[2].trim()})` : m[1]!);
          break;
        }
      }
      if (found.length >= 30) break;
    }
    if (found.length) symbols[f] = found;
  }

  const testFiles = files.filter((f) => /(\.|_)(test|spec)\.\w+$|(^|\/)test_\w+\.py$|(^|\/)tests?\/|(^|\/)spec\/|_test\.go$|(^|\/)src\/test\/|Tests?\.(cs|php|java|kt)$/.test(f));

  const stacks = detectStacks(root);
  const commands = detectCommands(root, stacks);
  // в проекте из частей пакеты лежат в package.json каждой node-части (web/package.json)
  const dependencies = projectDependencies(root, stacks.filter((s) => s.id === 'node').map((s) => s.dir));
  const tags = [...new Set([...stacks.flatMap((s) => [s.id, ...s.tags]), ...dependencies])];
  return { languages: [...languages], files, symbols, testFiles, commands, moduleSystem: detectModuleSystem(root, files), testRunner: detectTestRunner(root, testFiles), dependencies, stacks, tags };
}

/** ES-модули или CommonJS: сначала package.json, потом сами файлы. */
export function detectModuleSystem(root: string, files: string[]): 'esm' | 'cjs' | null {
  const pkgPath = path.join(root, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { type?: string };
      if (pkg.type === 'module') return 'esm';
    } catch {
      /* битый package.json — смотрим файлы */
    }
  }
  let esm = 0;
  let cjs = 0;
  for (const f of files.filter((x) => /\.(js|mjs|cjs|ts)$/.test(x)).slice(0, 50)) {
    const text = readFileSync(path.join(root, f), 'utf8');
    if (/^\s*(import\s.+from\s|export\s)/m.test(text) || f.endsWith('.mjs') || f.endsWith('.ts')) esm++;
    if (/\brequire\(|module\.exports|exports\.\w+\s*=/.test(text) || f.endsWith('.cjs')) cjs++;
  }
  if (esm === 0 && cjs === 0) return null;
  return esm >= cjs ? 'esm' : 'cjs';
}

export function detectTestRunner(root: string, testFiles: string[]): string | null {
  for (const f of testFiles.slice(0, 10)) {
    if (!/\.(m?[jt]s)$/.test(f)) continue;
    const text = readFileSync(path.join(root, f), 'utf8');
    if (/['"]node:test['"]/.test(text)) return 'node:test (встроенный в Node; проверки — node:assert)';
    if (/['"]vitest['"]/.test(text)) return 'vitest';
    if (/['"]@jest\/globals['"]|\bjest\./.test(text)) return 'jest';
  }
  const cmds = detectCommands(root);
  if (cmds.testFiles?.startsWith('node --test')) return 'node:test (встроенный в Node; проверки — node:assert)';
  if (cmds.testFiles?.includes('vitest')) return 'vitest';
  if (cmds.testFiles?.includes('jest')) return 'jest';
  if (cmds.testFiles?.includes('pytest')) return 'pytest';
  return null;
}

/** Правило стиля модулей простыми словами — его видят все роли. */
export function moduleRule(map: Pick<RepoMap, 'moduleSystem'>): string | null {
  if (map.moduleSystem === 'esm') return 'ES-модули: подключение через import, экспорт через export. require и module.exports в этом проекте НЕ работают.';
  if (map.moduleSystem === 'cjs') return 'CommonJS: подключение через require, экспорт через module.exports. import/export в этом проекте НЕ работают.';
  return null;
}

/** Установлена ли утилита в node_modules проекта (на Windows — .cmd). */
export function hasLocalBin(root: string, name: string): boolean {
  const bin = path.join(root, 'node_modules', '.bin', name);
  return existsSync(bin) || existsSync(`${bin}.cmd`);
}

export function detectCommands(root: string, stacks = detectStacks(root)): ProjectCommands {
  return combinedCommands(stacks);
}

/** Короткое текстовое оглавление для модели — одинаковое на весь прогон. */
export function renderRepoMap(map: RepoMap, maxChars = 6000): string {
  const head = [`Языки: ${map.languages.join(', ') || 'не определены'}`, `Тесты: ${map.commands.test ?? 'не найдены'}`];
  if (map.stacks?.length) head.push(`Части проекта: ${map.stacks.map((s) => `${s.dir || 'корень'} — ${s.name}`).join('; ')}`);
  if (map.commands.typecheck) head.push(`Сборка/типы: ${map.commands.typecheck}`);
  const rule = moduleRule(map);
  if (rule) head.push(`Модули: ${rule}`);
  if (map.testRunner) head.push(`Тест-раннер: ${map.testRunner}`);
  if (map.dependencies?.length) head.push(`Пакеты проекта: ${map.dependencies.slice(0, 40).join(', ')}`);
  const { groups: twins } = groupByTemplate(map.files);
  // однотипные файлы показываем всегда: по этим шаблонам планировщик ставит «правку по образцу» (similar)
  const twinLines = twins.filter((g) => /\.(m?[jt]sx?|vue|svelte|py|go|rs|java|kt|cs|php|rb)$/.test(g.template)).map((g) => `- ${g.template} — ${g.values.length} шт.`);
  const full = [
    ...head,
    ...(twinLines.length ? ['Однотипные файлы (одинаковую правку во всех — одной задачей с similar):', ...twinLines] : []),
    'Файлы:',
    ...map.files.map((f) => (map.symbols[f] ? `- ${f}: ${map.symbols[f]!.join(', ')}` : `- ${f}`)),
  ].join('\n');
  if (full.length <= maxChars) return full;

  // большой проект: одинаковые по устройству файлы сворачиваем в шаблоны («src/entities/*/api/*-api.ts — 16 шт.»)
  const { groups, rest } = groupByTemplate(map.files);
  const lines = [...head, `Файлов: ${map.files.length}. Повторяющиеся по устройству файлы свёрнуты в шаблоны: * — имя сущности.`, 'Шаблоны:'];
  for (const g of groups) {
    const ex = g.files[0]!;
    const sym = map.symbols[ex];
    lines.push(`- ${g.template} — ${g.values.length} шт.: ${g.values.slice(0, 24).join(', ')}${g.values.length > 24 ? ', …' : ''}`);
    lines.push(`    пример: ${ex}${sym ? `: ${sym.slice(0, 8).join(', ')}` : ''}`);
  }
  lines.push('Остальные файлы:');
  for (const f of rest) lines.push(map.symbols[f] ? `- ${f}: ${map.symbols[f]!.join(', ')}` : `- ${f}`);
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (список обрезан)` : text;
}

const pascal = (s: string) => s.split(/[-_]/).map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join('');
const camel = (s: string) => {
  const p = pascal(s);
  return p ? p[0]!.toLowerCase() + p.slice(1) : p;
};

/** Шаблон пути: сегмент i заменён на *, его же имя в остальной части пути — тоже (kebab, Pascal, camel). */
function templateOf(file: string, i: number): { template: string; value: string } | null {
  const parts = file.split('/');
  const value = parts[i]!;
  if (i === parts.length - 1 || value.length < 3 || /^[[(]/.test(value)) return null;
  const forms = [...new Set([value, pascal(value), camel(value)])].sort((a, b) => b.length - a.length);
  const rest = parts.slice(i + 1).map((seg) => forms.reduce((acc, f) => acc.split(f).join('*'), seg));
  return { template: [...parts.slice(0, i), '*', ...rest].join('/'), value };
}

export function groupByTemplate(files: string[], minGroup = 4): { groups: { template: string; values: string[]; files: string[] }[]; rest: string[] } {
  const byTemplate = new Map<string, { values: string[]; files: string[] }>();
  for (const f of files) {
    const n = f.split('/').length;
    for (let i = 0; i < n - 1; i++) {
      const t = templateOf(f, i);
      if (!t) continue;
      const g = byTemplate.get(t.template) ?? { values: [], files: [] };
      g.values.push(t.value);
      g.files.push(f);
      byTemplate.set(t.template, g);
    }
  }
  const covered = new Set<string>();
  const groups: { template: string; values: string[]; files: string[] }[] = [];
  const candidates = [...byTemplate].filter(([, g]) => new Set(g.values).size >= minGroup).sort((a, b) => b[1].files.length - a[1].files.length || a[0].length - b[0].length);
  for (const [template, g] of candidates) {
    const fresh = g.files.filter((f) => !covered.has(f));
    if (fresh.length < minGroup) continue;
    for (const f of fresh) covered.add(f);
    const idx = g.files.map((f, k) => (fresh.includes(f) ? k : -1)).filter((k) => k >= 0);
    groups.push({ template, values: idx.map((k) => g.values[k]!), files: idx.map((k) => g.files[k]!) });
  }
  return { groups, rest: files.filter((f) => !covered.has(f)) };
}
