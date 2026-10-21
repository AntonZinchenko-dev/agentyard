// Общее решение для пула однотипных задач: программа выводит из принятой правки образца
// набор правил «что на что заменить, что добавить, что убрать» и повторяет их в остальных файлах.
//
// Правила выводятся из текста файла ДО и ПОСЛЕ правки (а не из заплаток модели): так всё равно,
// прислала модель фрагменты или файл целиком. Правило годно, только если, применённое к старому
// тексту образца, оно даёт новый текст образца (проверка «воспроизводит образец»).
//
// Из правил же получаются подробные шаги для модели (если файл не подошёл программе)
// и машинные признаки готовности: чего в файле остаться не должно и что в нём должно появиться.

import { substitute } from './replicate.ts';

/** Замена: from → to во всех местах файла. line — заменяется целая строка (с сохранением отступа). */
export interface SubRule {
  from: string;
  to: string;
  line?: boolean;
}

/** Вставка строк: после импортов, в самое начало файла или после строки-якоря (якорь — строка нового текста). */
export interface InsertRule {
  lines: string[];
  where: 'imports' | 'top' | 'after';
  anchor?: string;
}

/**
 * Замена блока строк (6 строк шапки → 4): ищется по «форме» — строки те же, кроме текстов в кавычках и между тегами
 * (заголовок, адрес ссылки у каждой страницы свои). Эти тексты переносятся из найденного блока в новый.
 */
export interface BlockRule {
  del: string[];
  ins: string[];
}

export interface RuleSet {
  subs: SubRule[];
  blocks?: BlockRule[];
  inserts: InsertRule[];
  /** Строки, которые нужно убрать (без отступа). */
  removes: string[];
  /** Признаки готовности: чего в файле после правки быть не должно (было в образце до, исчезло после). */
  lacks: string[];
  /** Что должно появиться (импорты и новые теги образца). */
  has: string[];
  /** Правила, применённые к старому тексту образца, дают его новый текст. */
  exact: boolean;
}

export interface ApplyOutcome {
  text: string;
  changed: boolean;
  /** Признаки старого, которые остались в файле: правило их не покрыло — нужна модель. */
  leftovers: string[];
  /** Вставки, которые не удалось сделать (нет строки-якоря). */
  unmet: string[];
  /** В файле нечего менять: нет ни одного места из правил и ни одного признака старого. */
  nothingToDo: boolean;
}

// ---------- разбор текста ----------

const TOKEN_RE = /[\p{L}\p{N}_$]+|\s+|[^\p{L}\p{N}_$\s]/gu;
export function tokens(s: string): string[] {
  return s.match(TOKEN_RE) ?? [];
}
const isWord = (t: string) => /^[\p{L}\p{N}_$]+$/u.test(t);
const isSpace = (t: string) => /^\s+$/.test(t);

/** Строка импорта/подключения в разных языках. */
export function isImportLine(l: string): boolean {
  const s = l.trim();
  return /^(import\b|export\s+\*\s+from\b|from\s+\S+\s+import\b|use\s+[\w\\:]+|using\s+[\w.]+\s*;|#include\b|require(_once)?\b|@import\b|const\s+\{?[^=]*\}?\s*=\s*require\()/.test(s);
}
const isDirective = (l: string) => /^\s*['"]use (client|server|strict)['"];?\s*$/.test(l);

/** Сравнение строк без учёта пробелов, вида кавычек и точки с запятой в конце. */
export function norm(s: string): string {
  return s.replace(/["`]/g, "'").replace(/\s+/g, ' ').replace(/\s*;\s*$/, '').trim();
}

// ---------- форма строки: тексты в кавычках и между тегами — «дырки» ----------

const LIT = /"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|>[^<>{}\n]*[^\s<>{}][^<>{}\n]*</g;
/** Строка без своих текстов: <h1>Адреса</h1> и <h1>Заказы</h1> — одна форма. */
export function shape(l: string): string {
  return l.trim().replace(LIT, (m) => (m[0] === '>' ? '>§<' : `${m[0]}§${m[0]}`));
}
function literals(l: string): string[] {
  return [...l.matchAll(LIT)].map((m) => (m[0][0] === '>' ? m[0].slice(1, -1) : m[0].slice(1, -1)));
}
const indentOf = (l: string) => l.length - l.trimStart().length;

// ---------- построчное сравнение (наибольшая общая подпоследовательность) ----------

type Op = { k: 'eq' | 'del' | 'ins'; a?: string; b?: string };

function lcsOps<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): { k: 'eq' | 'del' | 'ins'; i: number; j: number }[] {
  const n = a.length;
  const m = b.length;
  const out: { k: 'eq' | 'del' | 'ins'; i: number; j: number }[] = [];
  if (n * m > 6_000_000) {
    // слишком большие куски — без выравнивания: всё старое удалено, всё новое вставлено
    for (let i = 0; i < n; i++) out.push({ k: 'del', i, j: -1 });
    for (let j = 0; j < m; j++) out.push({ k: 'ins', i: -1, j });
    return out;
  }
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = eq(a[i]!, b[j]!) ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(a[i]!, b[j]!)) {
      out.push({ k: 'eq', i, j });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) out.push({ k: 'del', i: i++, j: -1 });
    else out.push({ k: 'ins', i: -1, j: j++ });
  }
  while (i < n) out.push({ k: 'del', i: i++, j: -1 });
  while (j < m) out.push({ k: 'ins', i: -1, j: j++ });
  return out;
}

function diffLines(a: string[], b: string[]): Op[] {
  // общее начало и конец — сразу, чтобы таблица сравнения была маленькой
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const mid = lcsOps(a.slice(p, a.length - s), b.slice(p, b.length - s), (x, y) => x === y);
  return [
    ...a.slice(0, p).map((l) => ({ k: 'eq' as const, a: l, b: l })),
    ...mid.map((o) => (o.k === 'eq' ? { k: 'eq' as const, a: a[p + o.i], b: b[p + o.j] } : o.k === 'del' ? { k: 'del' as const, a: a[p + o.i] } : { k: 'ins' as const, b: b[p + o.j] })),
    ...a.slice(a.length - s).map((l) => ({ k: 'eq' as const, a: l, b: l })),
  ];
}

interface Hunk {
  del: string[];
  ins: string[];
  /** Строка нового текста перед вставкой (для якоря). */
  prevNew?: string;
  /** Блок стоит в самом начале файла. */
  atTop: boolean;
  /** Где блок начинается в старом тексте (индекс строки). */
  at: number;
}

function hunks(ops: Op[]): Hunk[] {
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  let prevNew: string | undefined;
  let seenEq = false;
  let ai = 0;
  for (const o of ops) {
    if (o.k === 'eq') {
      if (cur) out.push(cur);
      cur = null;
      if (o.b?.trim()) prevNew = o.b;
      seenEq = true;
      ai++;
      continue;
    }
    cur ??= { del: [], ins: [], prevNew, atTop: !seenEq, at: ai };
    if (o.k === 'del') {
      cur.del.push(o.a!);
      ai++;
    } else cur.ins.push(o.b!);
  }
  if (cur) out.push(cur);
  return out;
}

/** Похожесть строк по словам (коэффициент Дайса), 0..1. */
function similarity(a: string, b: string): number {
  const ta = tokens(a).filter((t) => !isSpace(t));
  const tb = tokens(b).filter((t) => !isSpace(t));
  if (!ta.length || !tb.length) return 0;
  const bag = new Map<string, number>();
  for (const t of ta) bag.set(t, (bag.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of tb) {
    const c = bag.get(t) ?? 0;
    if (c > 0) {
      common++;
      bag.set(t, c - 1);
    }
  }
  return (2 * common) / (ta.length + tb.length);
}

/** Пары «старая строка ↔ новая строка» внутри блока изменений; непарные — удаления и вставки. */
function pairLines(del: string[], ins: string[]): { pairs: [string, string][]; dels: string[]; inss: { line: string; index: number }[] } {
  if (del.length === ins.length) return { pairs: del.map((d, i) => [d, ins[i]!]), dels: [], inss: [] };
  const n = del.length;
  const m = ins.length;
  // выравнивание с наибольшей суммарной похожестью (только пары с похожестью ≥ 0.4)
  const w = m + 1;
  const best = new Float64Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = similarity(del[i]!, ins[j]!);
      const take = s >= 0.4 ? s + best[(i + 1) * w + j + 1]! : -1;
      best[i * w + j] = Math.max(take, best[(i + 1) * w + j]!, best[i * w + j + 1]!);
    }
  }
  const pairs: [string, string][] = [];
  const dels: string[] = [];
  const inss: { line: string; index: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const s = similarity(del[i]!, ins[j]!);
    if (s >= 0.4 && Math.abs(best[i * w + j]! - (s + best[(i + 1) * w + j + 1]!)) < 1e-9) {
      pairs.push([del[i]!, ins[j]!]);
      i++;
      j++;
    } else if (best[(i + 1) * w + j]! >= best[i * w + j + 1]!) dels.push(del[i++]!);
    else {
      inss.push({ line: ins[j]!, index: j });
      j++;
    }
  }
  while (i < n) dels.push(del[i++]!);
  while (j < m) {
    inss.push({ line: ins[j]!, index: j });
    j++;
  }
  return { pairs, dels, inss };
}

/** Замены внутри строки по словам: каждое отличие — с одним соседним словом слева и справа. */
function tokenRules(a: string, b: string): SubRule[] {
  const ta = tokens(a);
  const tb = tokens(b);
  const ops = lcsOps(ta, tb, (x, y) => x === y);
  // отрезки отличий: [начало в ta, конец в ta, начало в tb, конец в tb)
  const runs: { a0: number; a1: number; b0: number; b1: number }[] = [];
  let ia = 0;
  let ib = 0;
  let cur: { a0: number; a1: number; b0: number; b1: number } | null = null;
  for (const o of ops) {
    if (o.k === 'eq') {
      if (cur) runs.push(cur);
      cur = null;
      ia++;
      ib++;
    } else if (o.k === 'del') {
      cur ??= { a0: ia, a1: ia, b0: ib, b1: ib };
      cur.a1 = ++ia;
    } else {
      cur ??= { a0: ia, a1: ia, b0: ib, b1: ib };
      cur.b1 = ++ib;
    }
  }
  if (cur) runs.push(cur);
  // отличия через один пробел или знак сливаем — правило получается конкретнее и безопаснее
  const merged: typeof runs = [];
  for (const r of runs) {
    const last = merged.at(-1);
    if (last && r.a0 - last.a1 <= 1 && ta.slice(last.a1, r.a0).every((t) => isSpace(t) || t.length === 1)) {
      last.a1 = r.a1;
      last.b1 = r.b1;
    } else merged.push({ ...r });
  }
  const out: SubRule[] = [];
  for (const r of merged) {
    // слева — соседний знак; два знака подряд («</») берём оба, чтобы правило читалось как тег
    let left = r.a0 > 0 ? ta[r.a0 - 1]! : '';
    const punct = (x: string | undefined) => !!x && x.length === 1 && !isWord(x) && !isSpace(x);
    if (r.a0 > 1 && punct(left) && punct(ta[r.a0 - 2])) left = ta[r.a0 - 2]! + left;
    // слева слово (имя тега h1, атрибут) — берём и знак перед ним: «<h1» не совпадёт с «</h1»
    else if (r.a0 > 1 && isWord(left) && punct(ta[r.a0 - 2])) left = ta[r.a0 - 2]! + left;
    let right = r.a1 < ta.length ? ta[r.a1]! : '';
    if (isWord(right) && punct(ta[r.a1 + 1])) right += ta[r.a1 + 1]!;
    const from = left + ta.slice(r.a0, r.a1).join('') + right;
    const to = left + tb.slice(r.b0, r.b1).join('') + right;
    // слишком общее правило («(» → «[») опасно менять во всём файле — тогда меняем строку целиком
    const solid = tokens(from).some((t) => isWord(t) && t.length >= 2) || from.replace(/\s/g, '').length >= 4;
    if (!solid || !from.trim()) return [{ from: a.trim(), to: b.trim(), line: true }];
    out.push({ from, to });
  }
  return out;
}

// ---------- признаки старого и нового ----------

/** Теги (<td, </td) и CSS-классы из className/class — по ним видно, осталось ли старое. */
export function markersOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/<\/?[A-Za-z][\w.:-]*/g)) out.add(m[0]);
  for (const m of text.matchAll(/\bclass(?:Name)?\s*=\s*["'{`]+([^"'`}]*)/g)) {
    for (const c of m[1]!.split(/\s+/)) if (/^[A-Za-z_-][\w-]{2,}$/.test(c)) out.add(c);
  }
  return out;
}

/** Есть ли признак в тексте (с границей слова: <tr не находится в <track). */
export function hasMarker(text: string, marker: string): boolean {
  const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = /^[\w-]/.test(marker) ? '(?<![\\w-])' : '';
  const right = /[\w-]$/.test(marker) ? '(?![\\w-])' : '';
  return new RegExp(`${left}${esc}${right}`).test(text);
}

/** Есть ли строка в тексте с точностью до пробелов и вида кавычек. */
export function hasLine(text: string, line: string): boolean {
  const n = norm(line);
  return !!n && text.split('\n').some((l) => norm(l) === n);
}

// ---------- вывод правил ----------

export function learnRules(before: string, after: string): RuleSet {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  const subs: SubRule[] = [];
  const inserts: InsertRule[] = [];
  const removes: string[] = [];
  const conflict = new Set<string>();
  const addSub = (r: SubRule) => {
    const same = subs.find((x) => x.from === r.from && !!x.line === !!r.line);
    if (same && same.to !== r.to) conflict.add(r.from);
    else if (!same) subs.push(r);
  };
  const linePairs: [string, string][] = [];
  const blocks: BlockRule[] = [];
  for (const h of hunks(diffLines(a, b))) {
    // импорты отдельно: добавленные — вставкой после импортов, убранные — удалением (строки импорта уникальны)
    for (const d of h.del) if (d.trim() && isImportLine(d)) removes.push(d.trim());
    const delCode = h.del.filter((l) => !(l.trim() && isImportLine(l)));
    const insImports = h.ins.filter((l) => l.trim() && isImportLine(l));
    const pl = pairLines(delCode, h.ins.filter((l) => !(l.trim() && isImportLine(l))));
    if (pl.dels.some((d) => d.trim())) {
      // строки убираются без пары (блок шапки 6 строк → 4): заменой блока целиком, с соседними строками для однозначности
      const delLines = delCode;
      const insLines = h.ins.filter((l) => !(l.trim() && isImportLine(l)));
      let before = 0;
      let after = 0;
      const ctx = () => ({ del: [...a.slice(h.at - before, h.at), ...delLines, ...a.slice(h.at + h.del.length, h.at + h.del.length + after)], ins: [...a.slice(h.at - before, h.at), ...insLines, ...a.slice(h.at + h.del.length, h.at + h.del.length + after)] });
      const count = (del: string[]) => {
        const want = del.map(shape);
        let n = 0;
        for (let i = 0; i + want.length <= a.length; i++) if (want.every((w, j) => shape(a[i + j]!) === w)) n++;
        return n;
      };
      while (count(ctx().del) > 1 && (before < 4 || after < 3)) {
        if (before < 4 && h.at - before > 0) before++;
        else if (after < 3 && h.at + h.del.length + after < a.length) after++;
        else break;
      }
      blocks.push(ctx());
      if (insImports.length) inserts.push({ lines: insImports, where: 'imports' });
      continue;
    }
    const { pairs, dels, inss } = pairLines(h.del, h.ins);
    for (const [x, y] of pairs) {
      if (x.trim() === y.trim()) continue; // только отступ — не правило
      linePairs.push([x, y]);
      for (const r of tokenRules(x, y)) addSub(r);
    }
    for (const d of dels) if (d.trim() && !isImportLine(d)) removes.push(d.trim());
    // вставки: импорты — после импортов, директивы — в начало, остальное — после предыдущей строки нового текста
    let group: InsertRule | null = null;
    let lastIdx = -2;
    // строка нового текста перед вставкой (непустая): к ней и привязываем вставку
    const before = (idx: number) => {
      for (let k = idx - 1; k >= 0; k--) if (h.ins[k]!.trim()) return h.ins[k]!;
      return h.prevNew;
    };
    for (const { line, index } of inss) {
      const prevLine = before(index);
      if (!line.trim()) {
        lastIdx = index;
        continue;
      }
      const where: InsertRule['where'] = isImportLine(line) ? 'imports' : isDirective(line) && (h.atTop || !prevLine?.trim()) ? 'top' : 'after';
      if (group && group.where === where && index === lastIdx + 1 && where !== 'imports') group.lines.push(line);
      else {
        // у импорта якорь — соседний импорт образца (если его нет в файле — после последнего импорта)
        const anchor = (prevLine ?? '').trim();
        group = { lines: [line], where, ...(where === 'after' || (where === 'imports' && anchor && isImportLine(anchor)) ? { anchor } : {}) };
        if (where === 'after' && !group.anchor) group.where = 'top';
        inserts.push(group);
      }
      lastIdx = index;
    }
  }
  // правило с разными заменами одного и того же — ненадёжно: такие строки меняем целиком
  let finalSubs = subs.filter((r) => !conflict.has(r.from));
  if (conflict.size) {
    for (const [x, y] of linePairs) {
      if (tokenRules(x, y).some((r) => conflict.has(r.from))) finalSubs.push({ from: x.trim(), to: y.trim(), line: true });
    }
  }
  finalSubs = dedupe(finalSubs);

  const oldM = markersOf(before);
  const newM = markersOf(after);
  const changedText = [...finalSubs.map((r) => r.from), ...removes].join('\n');
  const addedText = [...finalSubs.map((r) => r.to), ...inserts.flatMap((i) => i.lines)].join('\n');
  const lacks = [...oldM].filter((m) => !newM.has(m) && hasMarker(changedText, m));
  const has = [
    ...inserts.filter((i) => i.where === 'imports').flatMap((i) => i.lines.map((l) => l.trim())),
    ...[...newM].filter((m) => !oldM.has(m) && m.startsWith('<') && hasMarker(addedText, m)).slice(0, 3),
  ];
  const blockText = blocks.flatMap((b) => b.del).join('\n');
  const blockNew = blocks.flatMap((b) => b.ins).join('\n');
  for (const m of [...oldM].filter((x) => !newM.has(x) && hasMarker(blockText, x) && !lacks.includes(x))) lacks.push(m);
  void blockNew;
  let rules: RuleSet = { subs: finalSubs, blocks, inserts, removes: [...new Set(removes)], lacks, has, exact: false };
  rules.exact = reproduces(rules, before, after);
  if (!rules.exact && linePairs.length) {
    // по словам не сошлось — пробуем целыми строками (строки с именем сущности подставятся при повторе)
    const byLine: RuleSet = { ...rules, subs: dedupe(linePairs.map(([x, y]) => ({ from: x.trim(), to: y.trim(), line: true }))) };
    if (reproduces(byLine, before, after)) rules = { ...byLine, exact: true };
  }
  return rules;
}

function dedupe(subs: SubRule[]): SubRule[] {
  const seen = new Set<string>();
  return subs.filter((r) => {
    const k = `${r.line ? 'L' : 'T'}\u0000${r.from}\u0000${r.to}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const canon = (s: string) =>
  s
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');

/** Правила, применённые к старому тексту образца, дают его новый текст (без учёта отступов и пустых строк). */
export function reproduces(rules: RuleSet, before: string, after: string): boolean {
  const r = applyRules(before, rules, []);
  return canon(r.text) === canon(after);
}

// ---------- применение к другому файлу ----------

/** Последняя строка блока импортов (многострочный import заканчивается строкой с from '…'). */
function lastImportIndex(lines: string[]): number {
  let last = -1;
  let inMulti = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (inMulti) {
      if (/\bfrom\s+['"][^'"]+['"];?$|^\}\s*from\b/.test(l) || /;\s*$/.test(l)) {
        inMulti = false;
        last = i;
      }
      continue;
    }
    if (isImportLine(l)) {
      last = i;
      if (/^import\b/.test(l) && !/\bfrom\b|^import\s+['"]/.test(l) && /\{\s*$|\{[^}]*$/.test(l)) inMulti = true;
      continue;
    }
    // после импортов начался код — дальше не ищем
    if (last >= 0 && l && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*') && !isDirective(l)) break;
  }
  return last;
}

function topIndex(lines: string[]): number {
  return lines[0]?.startsWith('#!') ? 1 : 0;
}

export function applyRules(text: string, rules: RuleSet, pairs: [string, string][]): ApplyOutcome {
  const crlf = text.includes('\r\n');
  const original = text.replace(/\r\n/g, '\n');
  const sub = (s: string) => substitute(s, pairs);
  let out = original;
  /** Сколько замен и удалений сработало (вставки не в счёт: импорт без замен — не повод трогать файл). */
  let hits = 0;
  /** Замены целой строки, которые не нашли свою строку (может быть, в файле она чуть другая). */
  const missedLines: SubRule[] = [];
  const missedBlocks: string[] = [];
  const origTrim = original.split('\n').map((l) => l.trim()).filter((l) => l.length >= 8);
  const origSimilar = (l: string) => origTrim.some((x) => similarity(x, l) >= 0.6);

  // 0. блоки: найти по форме, перенести свои тексты (заголовок, адрес) в новый блок
  for (const b of rules.blocks ?? []) {
    const lines = out.split('\n');
    const want = b.del.map((l) => shape(sub(l)));
    const at: number[] = [];
    for (let i = 0; i + want.length <= lines.length; i++) if (want.every((w, j) => shape(lines[i + j]!) === w)) at.push(i);
    if (at.length !== 1) {
      // блока нет совсем — к файлу не относится (если нет и следов старого); несколько — неоднозначно, к модели
      if (at.length > 1) missedBlocks.push(`блок из ${b.del.length} строк встречается ${at.length} раз`);
      else if (b.del.some((l) => l.trim().length >= 8 && origSimilar(sub(l)))) missedBlocks.push(`блок, похожий на «${sub(b.del.find((l) => l.trim())!.trim()).slice(0, 60)}»`);
      continue;
    }
    const i = at[0]!;
    const map = new Map<string, string>();
    b.del.forEach((l, j) => {
      const ex = literals(sub(l));
      const tg = literals(lines[i + j]!);
      ex.forEach((x, k) => {
        if (tg[k] !== undefined && x !== tg[k] && x.length >= 1) map.set(x, tg[k]!);
      });
    });
    const delta = indentOf(lines[i]!) - indentOf(b.del[0] ?? '');
    const fill = (l: string) => {
      let t = sub(l);
      // свои тексты страницы — в те же места нового блока (только внутри кавычек и между тегами)
      t = t.replace(LIT, (m) => {
        const q = m[0];
        const inner = m.slice(1, -1);
        const v = map.get(inner);
        return v === undefined ? m : q === '>' ? `>${v}<` : `${q}${v}${q}`;
      });
      if (delta > 0) return ' '.repeat(delta) + t;
      if (delta < 0) return t.slice(Math.min(-delta, indentOf(t)));
      return t;
    };
    lines.splice(i, b.del.length, ...b.ins.map(fill));
    out = lines.join('\n');
    hits++;
  }

  // 1. замены: длинные раньше коротких, чтобы короткое правило не съело часть длинного
  for (const r of [...rules.subs].sort((x, y) => y.from.length - x.from.length)) {
    if (r.line) {
      const variants = [...new Set([sub(r.from), r.from])];
      const lines = out.split('\n');
      let hit = false;
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i]!.trim();
        const v = variants.find((x) => x === t);
        if (v === undefined) continue;
        const indent = lines[i]!.slice(0, lines[i]!.length - lines[i]!.trimStart().length);
        lines[i] = indent + (v === r.from ? r.to : sub(r.to));
        hit = true;
      }
      if (hit) {
        out = lines.join('\n');
        hits++;
      } else missedLines.push(r);
      continue;
    }
    const f = sub(r.from);
    if (out.includes(f)) {
      out = out.split(f).join(sub(r.to));
      hits++;
    } else if (f !== r.from && out.includes(r.from)) {
      out = out.split(r.from).join(r.to);
      hits++;
    }
  }

  // 2. удаления строк
  if (rules.removes.length) {
    const kill = new Set(rules.removes.flatMap((l) => [norm(l), norm(sub(l))]));
    const lines = out.split('\n');
    const kept = lines.filter((l) => !(l.trim() && kill.has(norm(l))));
    if (kept.length !== lines.length) {
      out = kept.join('\n');
      hits++;
    }
  }

  // строка, похожая на заменяемую, но не та же (другой текст, другой атрибут) — правка к файлу относится, но вслепую не встаёт
  const unmet: string[] = [...missedBlocks];
  const origLines = original.split('\n').map((l) => l.trim()).filter((l) => l.length >= 8);
  for (const r of missedLines) {
    const f = sub(r.from);
    const done = norm(sub(r.to));
    if (origLines.some((l) => norm(l) !== done && similarity(l, f) >= 0.6)) unmet.push(`строка, похожая на ${f}`);
  }

  // ни одна замена не сработала и следов старого нет — к этому файлу правка не относится
  const onlyInserts = !rules.subs.length && !rules.removes.length && !rules.lacks.length && !(rules.blocks ?? []).length;
  const relevant = hits > 0 || unmet.length > 0 || onlyInserts || rules.lacks.some((m) => hasMarker(original, sub(m)) || hasMarker(original, m));
  if (!relevant) return { text, changed: false, leftovers: [], unmet: [], nothingToDo: true };

  // 3. вставки
  for (const ins of rules.inserts) {
    const lines = out.split('\n');
    // импорт и директиву не дублируем, если они уже есть где угодно; строку после якоря — если она уже стоит за якорем
    let add = ins.lines.map(sub);
    if (ins.where !== 'after') add = add.filter((l) => !hasLine(out, l));
    if (!add.length) continue;
    let at: number;
    const anchored = ins.where === 'imports' && ins.anchor ? lines.findIndex((l) => [norm(sub(ins.anchor!)), norm(ins.anchor!)].includes(norm(l))) : -1;
    if (anchored >= 0) at = anchored + 1;
    else if (ins.where === 'imports') {
      const li = lastImportIndex(lines);
      if (li >= 0) at = li + 1;
      else {
        // импортов нет: после директив вроде 'use client'
        let i = topIndex(lines);
        while (i < lines.length && (isDirective(lines[i]!) || !lines[i]!.trim())) i++;
        at = i;
      }
    } else if (ins.where === 'top') at = topIndex(lines);
    else {
      const anchors = [...new Set([norm(sub(ins.anchor ?? '')), norm(ins.anchor ?? '')])];
      const i = lines.findIndex((l) => anchors.includes(norm(l)));
      if (i < 0) {
        unmet.push(add.join('\n'));
        continue;
      }
      if (add.every((l, k) => norm(lines[i + 1 + k] ?? '') === norm(l))) continue;
      at = i + 1;
    }
    lines.splice(at, 0, ...add);
    out = lines.join('\n');
  }

  const leftovers = rules.lacks.filter((m) => hasMarker(out, sub(m)) || (sub(m) !== m && hasMarker(out, m)));
  const changed = out !== original;
  return { text: crlf ? out.replace(/\n/g, '\r\n') : out, changed, leftovers, unmet, nothingToDo: !changed && !leftovers.length && !unmet.length };
}

/** Файл подошёл: изменился, следов старого не осталось, все вставки встали. */
export function fits(o: ApplyOutcome): boolean {
  return o.changed && o.leftovers.length === 0 && o.unmet.length === 0 && !o.nothingToDo;
}

// ---------- шаги и признаки готовности для модели ----------

const code = (s: string) => `\`${s.length > 160 ? `${s.slice(0, 157)}…` : s}\``;

/** Подробные шаги для файла, который программа не смогла поправить сама. */
export function rulesSteps(rules: RuleSet, file: string, pairs: [string, string][], leftovers: string[] = []): string[] {
  const sub = (s: string) => substitute(s, pairs);
  const steps: string[] = [`Открой ${file} — правь только его.`];
  for (const ins of rules.inserts) {
    const lines = ins.lines.map(sub).map(code).join(' и ');
    if (ins.where === 'imports') steps.push(`Если такого импорта ещё нет — добавь после последнего import: ${lines}.`);
    else if (ins.where === 'top') steps.push(`Если этого ещё нет — добавь в самое начало файла: ${lines}.`);
    else steps.push(`После строки ${code(sub(ins.anchor ?? ''))} добавь: ${lines}.`);
  }
  for (const b of rules.blocks ?? []) {
    steps.push(`Найди блок (тексты в кавычках и между тегами в твоём файле свои):\n\`\`\`\n${b.del.map(sub).join('\n')}\n\`\`\`\nи замени его на такой же, сохранив свои тексты:\n\`\`\`\n${b.ins.map(sub).join('\n')}\n\`\`\``);
  }
  const subs = rules.subs.slice(0, 14);
  for (const r of subs) steps.push(`${r.line ? 'Строку' : 'Каждое'} ${code(sub(r.from))} замени на ${code(sub(r.to))}.`);
  if (rules.subs.length > subs.length) steps.push(`И так же остальные похожие места (всего замен в образце: ${rules.subs.length}).`);
  for (const l of rules.removes.slice(0, 6)) steps.push(`Убери строку ${code(sub(l))}.`);
  if (leftovers.length) steps.push(`Программа не смогла заменить сама: в файле есть варианты, которых не было в образце (${leftovers.map(code).join(', ')}). Поменяй их по тому же принципу.`);
  const lacks = rules.lacks.map(sub);
  const has = rules.has.map(sub);
  if (lacks.length || has.length) {
    steps.push(
      `Проверь себя перед сдачей: ${lacks.length ? `в файле не должно остаться ${lacks.slice(0, 8).map(code).join(', ')}` : ''}${lacks.length && has.length ? '; ' : ''}${has.length ? `должно быть ${has.slice(0, 4).map(code).join(', ')}` : ''}.`,
    );
  }
  return steps;
}

/** Признаки готовности файла для проверки программой. */
export function rulesDoneWhen(rules: RuleSet, file: string, pairs: [string, string][]): { file: string; lacks: string[]; has: string[] } {
  const sub = (s: string) => substitute(s, pairs);
  return { file, lacks: rules.lacks.map(sub), has: rules.has.map(sub) };
}

/** Короткое человеческое описание решения (для журнала решений). */
export function rulesSummary(rules: RuleSet, max = 4): string[] {
  const out: string[] = [];
  for (const i of rules.inserts.filter((x) => x.where === 'imports').slice(0, 2)) out.push(`импорт ${code(i.lines[0]!.trim())}`);
  for (const b of (rules.blocks ?? []).slice(0, 2)) out.push(`блок из ${b.del.length} строк → ${b.ins.length} (${code(b.ins.find((l) => l.trim())?.trim() ?? '')}…)`);
  for (const r of rules.subs.slice(0, max)) out.push(`${code(r.from.trim())} → ${code(r.to.trim())}`);
  if (rules.subs.length > max) out.push(`и ещё ${rules.subs.length - max} замен(ы)`);
  return out;
}
