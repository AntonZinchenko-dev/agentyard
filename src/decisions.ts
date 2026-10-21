// Журнал принятых решений — «контекст сверху» матрёшки.
//
// Каждая влитая задача оставляет короткие факты о том, что она решила: какие файлы создала,
// какие импорты и компоненты ввела, что убрала, какие пакеты поставила. Факты вычисляет программа
// по diff (а не модель по памяти), поэтому им можно верить.
//
// Факты идут:
//   вниз  — частям задачи (что уже решено у родителя и предков);
//   вбок  — соседним частям, задачам того же пула и тем, что зависят от сделанной;
//   вверх — при сборке родителя из частей: решения частей становятся решением родителя;
// а ещё «как починили»: задача, справившаяся с ошибкой, оставляет рецепт тем, кто падает на той же.

import { isImportLine, markersOf } from './rules.ts';
import type { Task } from './types.ts';

export interface Decision {
  taskId: string;
  title: string;
  facts: string[];
  files: string[];
  /** Кто сделал: модель, человек или программа по образцу. */
  by?: string;
  pool?: string;
  parent?: string;
}

export interface FixRecipe {
  /** Подпись ошибки (ступень:текст), на которой задача падала до того, как справилась. */
  signature: string;
  taskId: string;
  facts: string[];
}

export interface FileChange {
  file: string;
  before: string | null;
  after: string | null;
}

const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const code = (s: string) => `\`${short(s.trim(), 110)}\``;

/** Факты о правке — из текстов файлов до и после. */
export function extractFacts(changes: FileChange[], extra: { note?: string; installed?: string[]; how?: string[] } = {}): string[] {
  const facts: string[] = [];
  const imports = new Map<string, string[]>();
  const dropped = new Map<string, string[]>();
  const tagsNew = new Set<string>();
  const tagsGone = new Set<string>();
  const clsNew = new Set<string>();
  const clsGone = new Set<string>();
  for (const c of changes) {
    if (c.before === null && c.after !== null) {
      const exp = [...c.after.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|interface|type)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!);
      facts.push(`создан ${c.file}${exp.length ? ` (экспорт: ${[...new Set(exp)].slice(0, 4).join(', ')})` : ''}`);
    } else if (c.after === null) {
      facts.push(`удалён ${c.file}`);
      continue;
    }
    const before = (c.before ?? '').replace(/\r\n/g, '\n');
    const after = (c.after ?? '').replace(/\r\n/g, '\n');
    const bl = new Set(before.split('\n').map((l) => l.trim()));
    const al = new Set(after.split('\n').map((l) => l.trim()));
    for (const l of al) if (l && isImportLine(l) && !bl.has(l)) imports.set(l, [...(imports.get(l) ?? []), c.file]);
    for (const l of bl) if (l && isImportLine(l) && !al.has(l)) dropped.set(l, [...(dropped.get(l) ?? []), c.file]);
    if (/^['"]use client['"]/m.test(after) && !/^['"]use client['"]/m.test(before)) facts.push(`'use client' в ${c.file}`);
    const mb = markersOf(before);
    const ma = markersOf(after);
    for (const m of ma) if (!mb.has(m) && !m.startsWith('</')) (m.startsWith('<') ? tagsNew : clsNew).add(m);
    for (const m of mb) if (!ma.has(m) && !m.startsWith('</')) (m.startsWith('<') ? tagsGone : clsGone).add(m);
    if (/\.(css|scss|sass|less)$/i.test(c.file)) {
      const sel = [...after.matchAll(/^\s*([^{}@/\n][^{}\n]*)\{/gm)].map((m) => m[1]!.trim()).filter((s) => !before.includes(`${s} {`) && !before.includes(`${s}{`));
      if (sel.length) facts.push(`в ${c.file} новые правила: ${sel.slice(0, 5).join(', ')}`);
    }
  }
  const where = (files: string[]) => (files.length > 1 ? ` (в ${files.length} файлах)` : ` (${files[0]})`);
  for (const [l, files] of [...imports].slice(0, 3)) facts.push(`импорт ${code(l)}${where(files)}`);
  for (const [l, files] of [...dropped].slice(0, 2)) facts.push(`убран импорт ${code(l)}${where(files)}`);
  if (tagsNew.size) facts.push(`теперь используется ${[...tagsNew].slice(0, 5).map((t) => `${t}>`).join(', ')}`);
  if (tagsGone.size) facts.push(`больше нет ${[...tagsGone].slice(0, 5).map((t) => `${t}>`).join(', ')}`);
  if (clsGone.size) facts.push(`убраны классы ${[...clsGone].slice(0, 5).join(', ')}`);
  if (clsNew.size) facts.push(`новые классы ${[...clsNew].slice(0, 5).join(', ')}`);
  for (const h of extra.how ?? []) facts.push(h);
  if (extra.installed?.length) facts.push(`поставлены пакеты ${extra.installed.join(', ')}`);
  if (extra.note?.trim()) facts.push(`исполнитель: «${short(extra.note.trim(), 150)}»`);
  return [...new Set(facts)].slice(0, 9);
}

export class DecisionLog {
  private list: Decision[] = [];
  private fixes: FixRecipe[] = [];

  add(d: Decision): void {
    this.list = this.list.filter((x) => x.taskId !== d.taskId);
    this.list.push(d);
  }

  get(taskId: string): Decision | undefined {
    return this.list.find((d) => d.taskId === taskId);
  }

  all(): Decision[] {
    return [...this.list];
  }

  addFix(f: FixRecipe): void {
    if (!f.signature || this.fixes.some((x) => x.signature === f.signature && x.taskId === f.taskId)) return;
    this.fixes.push(f);
  }

  /** Как уже справились с той же ошибкой (другая задача, та же подпись). */
  fixFor(t: Task): FixRecipe | undefined {
    const sig = t.failures.at(-1);
    if (!sig) return undefined;
    const key = fixKey(sig);
    return this.fixes.find((f) => f.taskId !== t.id && fixKey(f.signature) === key);
  }

  /**
   * Решения, которые касаются задачи: предки и их зависимости, свои зависимости (с их предками),
   * соседние части, тот же пул, общие файлы. Ближние — первыми.
   */
  relevant(t: Task, all: Map<string, Task>, max = 8): Decision[] {
    const score = new Map<string, number>();
    const bump = (id: string, s: number) => score.set(id, Math.max(score.get(id) ?? 0, s));
    const up = (id: string | undefined, s: number) => {
      for (let cur = id, depth = 0; cur && depth < 6; cur = all.get(cur)?.parent, depth++) bump(cur, s - depth);
    };
    const deps = (id: string, s: number, seen = new Set<string>()) => {
      const x = all.get(id);
      if (!x || seen.has(id)) return;
      seen.add(id);
      for (const d of x.dependsOn) {
        bump(d, s);
        up(all.get(d)?.parent, s - 1);
        for (const c of all.get(d)?.children ?? []) bump(c, s - 1);
        deps(d, s - 1, seen);
      }
    };
    up(t.parent, 90);
    deps(t.id, 80);
    for (let cur = t.parent; cur; cur = all.get(cur)?.parent) deps(cur, 70);
    // повтор решения: то, на что опирался образец (его зависимости), — тоже контекст
    if (t.solutionFrom) deps(t.solutionFrom, 75);
    if (t.pool && t.pool !== t.solutionFrom) deps(t.pool, 74);
    for (const x of all.values()) {
      if (x.id === t.id) continue;
      if (t.parent && x.parent === t.parent) bump(x.id, 85);
      if (t.pool && x.pool === t.pool) bump(x.id, 88);
      if (t.solutionFrom === x.id) bump(x.id, 95);
    }
    const files = new Set(t.files);
    const out: { d: Decision; s: number; i: number }[] = [];
    this.list.forEach((d, i) => {
      if (d.taskId === t.id) return;
      let s = score.get(d.taskId) ?? 0;
      if (!s && d.files.some((f) => files.has(f))) s = 60;
      if (s > 0) out.push({ d, s, i });
    });
    return out.sort((a, b) => b.s - a.s || b.i - a.i).slice(0, max).map((x) => x.d);
  }

  /** Текст для промпта, в пределах бюджета символов. */
  static render(ds: Decision[], budget = 2400): string {
    const lines: string[] = [];
    let used = 0;
    for (const d of ds) {
      const line = `- ${d.taskId} «${short(d.title, 70)}»${d.by ? ` (${d.by})` : ''}: ${d.facts.join('; ') || 'сделано'}`;
      if (used + line.length > budget) break;
      lines.push(line);
      used += line.length;
    }
    return lines.join('\n');
  }

  toJSON(): { list: Decision[]; fixes: FixRecipe[] } {
    return { list: this.list, fixes: this.fixes };
  }

  static from(json: { list?: Decision[]; fixes?: FixRecipe[] } | undefined): DecisionLog {
    const log = new DecisionLog();
    log.list = [...(json?.list ?? [])];
    log.fixes = [...(json?.fixes ?? [])];
    return log;
  }
}

/** Подпись ошибки без чисел и путей: «5:typecheck:TS2304 Cannot find name 'Table'» одинакова у разных файлов. */
export function fixKey(sig: string): string {
  return sig
    .toLowerCase()
    .replace(/[\w./\\-]+\.(tsx?|jsx?|py|go|rs|java|cs|php|rb|css)\b/g, 'F')
    .replace(/\(\d+,\d+\)|:\d+(:\d+)?/g, '')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
}
