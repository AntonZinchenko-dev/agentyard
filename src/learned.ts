// Копилка решений: как уже справлялись с ошибками — по разделам, с тегами, с поиском.
//
// Когда задача падала на проверке (синтаксис, линтер, типы, тесты, пакеты), а потом прошла — у агента или у человека, —
// программа записывает: какая была ошибка (без путей проекта), что помогло (факты по diff, заметка исполнителя),
// кусок правки и откуда взята справка. Файлы — обычный Markdown в skills/learned/<раздел>.md: их можно читать,
// править и отдавать коллегам.
//
// При новой ошибке программа ищет здесь первой: совпадение кода ошибки, библиотек, имён из текста ошибки
// и похожесть самого текста. Найденное уходит исполнителю раньше поиска в интернете.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SECTIONS: Record<string, string> = {
  types: 'Типы и сборка',
  lint: 'Линтер',
  syntax: 'Синтаксис',
  tests: 'Тесты',
  packages: 'Пакеты и зависимости',
  other: 'Прочее',
};

export interface Solution {
  id: string;
  section: string;
  title: string;
  tags: string[];
  error: string;
  fix: string[];
  example?: string;
  sources?: string[];
  seen: number;
  last: string;
  where?: string;
}

/** Раздел по подписи ошибки каскада («5:typecheck:…» → types). */
export function sectionOf(signature: string): string {
  const stage = /^(\d):/.exec(signature)?.[1];
  if (stage === '3') return 'syntax';
  if (stage === '4') return 'lint';
  if (stage === '5') return 'types';
  if (stage === '6') return 'tests';
  if (/^install|ERESOLVE|npm ERR/i.test(signature)) return 'packages';
  return 'other';
}

/** Первая содержательная строка ошибки без путей проекта, номеров строк и длинных литералов. */
export function cleanError(output: string): string {
  const line =
    output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /error|Error|ошибка|TS\d{4}|cannot|not assignable|does not exist|expected|failed|ERR!/i.test(l) && !/^(Новые ошибки|Ступень|Команда:|>)/.test(l)) ??
    output.split(/\r?\n/).find((l) => l.trim()) ??
    '';
  return line
    .replace(/^[^\s]*\.(tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|cs|php|rb|vue|css|scss)(\(\d+,\d+\)|:\d+(:\d+)?)?:?\s*/i, '')
    .replace(/[A-Za-z]:\\[^\s'"]+|(?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w.-]+\.\w+/g, '<файл>')
    .replace(/\{[^{}]{80,}\}/g, '{…}')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}_$]{3,}/gu) ?? []).filter((w) => !['error', 'the', 'type', 'and', 'for', 'not', 'файл'].includes(w)));

/** Теги ошибки: коды (ts2322, eresolve), библиотеки (@mantine/core → mantine, mantine@9), имена из ошибки, язык. */
export function tagsFor(error: string, opts: { files?: string[]; imports?: string[]; deps?: Record<string, string>; stack?: string[] } = {}): string[] {
  const tags = new Set<string>();
  for (const m of error.matchAll(/\b(TS\d{4}|E[A-Z]{3,}|[A-Z][a-z]+Error|E\d{3,4}|[CW]\d{4})\b/g)) tags.add(m[1]!.toLowerCase());
  for (const m of error.matchAll(/'([A-Za-z_$][\w$]{2,})'/g)) if (!/^(string|number|boolean|undefined|null|any|unknown|never|object)$/.test(m[1]!)) tags.add(m[1]!.toLowerCase());
  const low = error.toLowerCase();
  for (const [name, ver] of Object.entries(opts.deps ?? {})) {
    const key = name.startsWith('@') ? name.slice(1).split('/')[0]! : name;
    if (key.length < 3) continue;
    if (low.includes(key.toLowerCase()) || (opts.imports ?? []).some((i) => i === name || i.startsWith(`${name}/`))) {
      tags.add(key.toLowerCase());
      const major = String(ver).replace(/^[^\d]*/, '').split('.')[0];
      if (major) tags.add(`${key.toLowerCase()}@${major}`);
    }
  }
  for (const f of opts.files ?? []) {
    const ext = path.extname(f).slice(1).toLowerCase();
    if (ext) tags.add(ext);
  }
  for (const s of opts.stack ?? []) tags.add(s.toLowerCase());
  return [...tags].slice(0, 16);
}

/** Заголовок записи: самое говорящее из ошибки («'colorScheme' нет в типе MantineProviderProps»), а не первая строка. */
export function titleFor(output: string, code?: string): string {
  const prefix = code ? `${code.toUpperCase()}: ` : '';
  const strip = (t: string) => t.replace(/IntrinsicAttributes\s*&\s*/g, '').replace(/^\{.*\}$/, 'объект').slice(0, 60);
  const prop = /Property '([^']+)' does not exist on type '([^']+)'/.exec(output) ?? /'([^']+)' does not exist in type '([^']+)'/.exec(output);
  if (prop) return `${prefix}'${prop[1]}' нет в типе ${strip(prop[2]!)}`;
  const name = /Cannot find (?:name|module) '([^']+)'/.exec(output);
  if (name) return `${prefix}не найдено '${name[1]}'`;
  return `${prefix}${cleanError(output).replace(/^error\s+TS\d+:\s*/i, '').slice(0, 90)}`;
}

/** Короткий id: код ошибки + главные слова + библиотека. */
export function solutionId(error: string, tags: string[]): string {
  const code = tags.find((t) => /^(ts\d{4}|e[a-z]{3,}|[a-z]+error)$/.test(t)) ?? '';
  const names = tags.filter((t) => !/^(ts\d{4}|e[a-z]{3,}|[a-z]+error|tsx?|jsx?|py|css)$/.test(t) && !t.includes('@')).slice(0, 3);
  const base = [code, ...names].filter(Boolean).join('-') || [...words(error)].slice(0, 4).join('-');
  return base.replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'reshenie';
}

// ---------- хранение: Markdown по разделам ----------

function render(section: string, list: Solution[]): string {
  const head = `# Копилка решений: ${SECTIONS[section] ?? section}\n\nПишет AgentYard: ошибка, на которой падала задача, и что помогло, когда она прошла. Можно править руками; формат — заголовок ## и строки «- теги:», «- ошибка:», «- решение:».\n`;
  const body = list.map((s) =>
    [
      `## ${s.title}`,
      `<!-- id: ${s.id} -->`,
      `- теги: ${s.tags.join(', ')}`,
      `- ошибка: ${s.error}`,
      '- решение:',
      ...s.fix.map((f) => `  - ${f}`),
      ...(s.example ? ['- пример:', '  ```diff', ...s.example.split('\n').map((l) => `  ${l}`), '  ```'] : []),
      ...(s.sources?.length ? [`- источники: ${s.sources.join(' ')}`] : []),
      `- встречалось: ${s.seen} раз(а), последний ${s.last}${s.where ? ` (${s.where})` : ''}`,
    ].join('\n'),
  );
  return `${head}\n${body.join('\n\n')}\n`;
}

export function parseSection(section: string, text: string): Solution[] {
  const out: Solution[] = [];
  for (const block of text.split(/\n(?=## )/).filter((b) => b.startsWith('## '))) {
    const lines = block.split('\n');
    const title = lines[0]!.slice(3).trim();
    const get = (k: string) => lines.find((l) => l.startsWith(`- ${k}:`))?.slice(k.length + 3).trim() ?? '';
    const id = /<!--\s*id:\s*([^\s]+)\s*-->/.exec(block)?.[1] ?? solutionId(get('ошибка') || title, []);
    const fix: string[] = [];
    let i = lines.findIndex((l) => l.startsWith('- решение:'));
    if (i >= 0) for (i++; i < lines.length && /^\s{2,}- /.test(lines[i]!); i++) fix.push(lines[i]!.replace(/^\s+- /, ''));
    const ex = /- пример:\n\s*```diff\n([\s\S]*?)\n\s*```/.exec(block)?.[1];
    const seen = /встречалось:\s*(\d+)/.exec(block)?.[1];
    const last = /последний\s+(\d{4}-\d{2}-\d{2})/.exec(block)?.[1];
    const where = /последний\s+\d{4}-\d{2}-\d{2}\s+\(([^)]*)\)/.exec(block)?.[1];
    out.push({
      id,
      section,
      title,
      tags: get('теги').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
      error: get('ошибка'),
      fix,
      ...(ex ? { example: ex.split('\n').map((l) => l.replace(/^ {2}/, '')).join('\n') } : {}),
      ...(get('источники') ? { sources: get('источники').split(/\s+/).filter(Boolean) } : {}),
      seen: seen ? Number(seen) : 1,
      last: last ?? '',
      ...(where ? { where } : {}),
    });
  }
  return out;
}

export interface Hit {
  s: Solution;
  score: number;
}

export class SolutionBook {
  readonly dir: string | null;
  private items: Solution[] = [];

  /** dir = null — копилка только в памяти (тесты, учебная модель). */
  constructor(dir: string | null) {
    this.dir = dir;
    if (dir && existsSync(dir)) {
      for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
        try {
          this.items.push(...parseSection(f.replace(/\.md$/, ''), readFileSync(path.join(dir, f), 'utf8')));
        } catch {
          /* битый файл — пропускаем */
        }
      }
    }
  }

  all(): Solution[] {
    return [...this.items];
  }

  /**
   * Поиск по ошибке: коды ошибок и имена весят больше всего, библиотеки и язык — меньше,
   * плюс похожесть текста ошибки. Возвращает только уверенные совпадения.
   */
  search(q: { text: string; tags: string[] }, max = 2): Hit[] {
    const qw = words(q.text);
    const qt = new Set(q.tags.map((t) => t.toLowerCase()));
    const hits: Hit[] = [];
    for (const s of this.items) {
      let score = 0;
      let strong = false;
      for (const t of s.tags) {
        if (!qt.has(t)) continue;
        const code = /^(ts\d{4}|e[a-z]{3,}|[a-z]+error|e\d{3,4}|[cw]\d{4})$/.test(t);
        const ext = /^(tsx?|jsx?|py|css|scss|vue|go|rs|java|cs|php|rb)$/.test(t);
        score += code ? 4 : ext ? 0.5 : 1.5;
        if (code) strong = true;
      }
      const sw = words(`${s.error} ${s.title}`);
      let common = 0;
      for (const w of qw) if (sw.has(w)) common++;
      const sim = qw.size && sw.size ? common / (qw.size + sw.size - common) : 0;
      score += sim * 6;
      if (sim >= 0.35) strong = true;
      score += Math.min(2, Math.log2(1 + s.seen) * 0.5);
      if (score >= 5 && strong) hits.push({ s, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, max);
  }

  /** Подсказки для планировщика: решения по библиотекам и технологиям цели (без кода ошибки). */
  byTags(tags: string[], max = 3): Solution[] {
    const want = new Set(tags.map((t) => t.toLowerCase()));
    return this.items
      .map((s) => ({ s, n: s.tags.filter((t) => want.has(t) && !/^(tsx?|jsx?|css)$/.test(t)).length }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n || b.s.seen - a.s.seen)
      .slice(0, max)
      .map((x) => x.s);
  }

  /** Записать решение (то же — увеличить счётчик и дополнить). Возвращает путь файла раздела и новое ли оно. */
  add(s: Omit<Solution, 'seen' | 'last'> & { seen?: number; last?: string }): { file: string | null; fresh: boolean; solution: Solution } {
    const today = new Date().toISOString().slice(0, 10);
    const prev = this.items.find((x) => x.id === s.id && x.section === s.section);
    let solution: Solution;
    if (prev) {
      prev.seen += 1;
      prev.last = today;
      prev.where = s.where ?? prev.where;
      prev.tags = [...new Set([...prev.tags, ...s.tags])].slice(0, 20);
      for (const f of s.fix) if (!prev.fix.includes(f) && prev.fix.length < 8) prev.fix.push(f);
      if (!prev.example && s.example) prev.example = s.example;
      if (s.sources?.length) prev.sources = [...new Set([...(prev.sources ?? []), ...s.sources])].slice(0, 5);
      solution = prev;
    } else {
      solution = { ...s, seen: s.seen ?? 1, last: s.last ?? today };
      this.items.push(solution);
    }
    let file: string | null = null;
    if (this.dir) {
      mkdirSync(this.dir, { recursive: true });
      file = path.join(this.dir, `${s.section}.md`);
      const list = this.items.filter((x) => x.section === s.section).sort((a, b) => b.seen - a.seen || (a.last < b.last ? 1 : -1)).slice(0, 200);
      writeFileSync(file, render(s.section, list));
    }
    return { file, fresh: !prev, solution };
  }

  /** Текст для исполнителя. */
  static render(hits: Solution[]): string {
    return hits
      .map((s) =>
        [
          `### ${s.title} (раздел «${SECTIONS[s.section] ?? s.section}», встречалось ${s.seen} раз)`,
          `Ошибка: ${s.error}`,
          'Что помогло:',
          ...s.fix.map((f) => `- ${f}`),
          ...(s.example ? ['```diff', s.example, '```'] : []),
          ...(s.sources?.length ? [`Источники: ${s.sources.join(' ')}`] : []),
        ].join('\n'),
      )
      .join('\n\n');
  }
}

/** Кусок правки для примера: изменения рядом с именами из ошибки (или первое изменение), не длиннее max строк. */
export function exampleFromDiff(diff: string, names: string[], max = 18): string {
  const hunks = diff.split(/\n(?=@@)/).filter((h) => h.startsWith('@@'));
  if (!hunks.length) return '';
  const low = names.map((n) => n.toLowerCase());
  const pick = hunks.find((h) => low.some((n) => h.toLowerCase().includes(n))) ?? hunks[0]!;
  const lines = pick.split('\n').slice(1).filter((l) => /^[-+ ]/.test(l));
  return lines.slice(0, max).join('\n') + (lines.length > max ? '\n…' : '');
}
