// Правка по образцу: одна и та же правка во многих однотипных файлах (48 сгенерированных страниц).
// Модель правит один файл-образец, программа повторяет её в остальных файлах шаблона.
// Повтор точный: если в файле нет того же фрагмента (с поправкой на имя сущности) — файл уходит отдельной задачей.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { applyPatches } from './tools/patch.ts';
import type { Patch } from './types.ts';

/** Шаблон пути с * → регулярное выражение с группами (каждая * — имя сущности). */
export function templateRegex(glob: string): RegExp {
  const esc = glob.replace(/\\/g, '/').replace(/[.+?^${}()|[\]]/g, '\\$&').replace(/\*/g, '([^/]*?)');
  return new RegExp(`^${esc}$`);
}

export function matchFiles(glob: string, files: string[]): string[] {
  const re = templateRegex(glob);
  return files.filter((f) => re.test(f));
}

const pascal = (s: string) => s.split(/[-_]/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
const camel = (s: string) => {
  const p = pascal(s);
  return p ? p[0]!.toLowerCase() + p.slice(1) : p;
};
const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();

/** Английское множественное число для имён сущностей (address → addresses, category → categories, user → users). */
export function plural(w: string): string {
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(w)) return `${w}es`;
  return `${w}s`;
}

/** Чем отличаются два файла шаблона: пары «имя в образце → имя в цели» во всех написаниях. */
export function entityPairs(glob: string, example: string, target: string): [string, string][] {
  const re = templateRegex(glob);
  const a = re.exec(example);
  const b = re.exec(target);
  if (!a || !b) return [];
  const cores = new Map<string, string>();
  for (let i = 1; i < a.length; i++) {
    let x = a[i]!;
    let y = b[i]!;
    if (x === y) continue;
    // общий хвост и начало — не имя сущности: address-list / user-list → address / user
    while (x.length && y.length && x.at(-1) === y.at(-1)) {
      x = x.slice(0, -1);
      y = y.slice(0, -1);
    }
    while (x.length && y.length && x[0] === y[0]) {
      x = x.slice(1);
      y = y.slice(1);
    }
    x = x.replace(/^[-_]+|[-_]+$/g, '');
    y = y.replace(/^[-_]+|[-_]+$/g, '');
    if (x && y) cores.set(kebab(x), kebab(y));
  }
  const pairs: [string, string][] = [];
  // множественное число: /addresses/new → /orders/new, useAddressesList → useOrdersList, categories
  for (const [x, y] of [...cores]) cores.set(plural(x), plural(y));
  for (const [x, y] of cores) {
    for (const [fx, fy] of [
      [x, y],
      [pascal(x), pascal(y)],
      [camel(x), camel(y)],
      [x.replace(/-/g, '_'), y.replace(/-/g, '_')],
    ] as [string, string][]) {
      if (fx && !pairs.some(([p]) => p === fx)) pairs.push([fx, fy]);
    }
  }
  return pairs.sort((p, q) => q[0].length - p[0].length);
}

/** Подставить имена сущности за один проход (без повторной замены уже заменённого). */
export function substitute(text: string, pairs: [string, string][]): string {
  if (!pairs.length) return text;
  const re = new RegExp(pairs.map(([p]) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const map = new Map(pairs);
  return text.replace(re, (m) => map.get(m) ?? m);
}

/** Ближайшие непустые строки до и после фрагмента в тексте (образец уже исправлен — ищем новый текст). */
function neighbours(text: string, fragment: string): [string | undefined, string | undefined] {
  const at = fragment ? text.indexOf(fragment.replace(/\r\n/g, '\n')) : -1;
  if (at < 0) return [undefined, undefined];
  const before = text.slice(0, at).split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
  const after = text.slice(at + fragment.length).split('\n').map((l) => l.trim()).filter(Boolean)[0];
  return [before, after];
}

export interface ReplicateResult {
  applied: string[];
  failed: string[];
  /** В файле нет ни одного фрагмента образца — менять там нечего (форма, где нет кнопки «Добавить»). */
  skipped: string[];
}

/** Есть ли фрагмент в тексте — точно или построчно без учёта отступов. */
function present(text: string, search: string): boolean {
  const t = text.replace(/\r\n/g, '\n');
  const s = search.replace(/\r\n/g, '\n');
  if (t.includes(s)) return true;
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  const tl = t.split('\n').map((l) => l.trim());
  return tl.some((_, i) => lines.every((l, j) => tl[i + j] === l));
}

/**
 * Повторить правки образца в целевых файлах. Каждый файл — атомарно: либо правка встала целиком, либо файл не тронут.
 * Сначала пробуем с подстановкой имени сущности, потом как есть (общие фрагменты вроде className="af-btn primary").
 */
export function replicate(root: string, glob: string, example: string, patches: Patch[], targets: string[], frozen: string[] = []): ReplicateResult {
  const own = patches.filter((p) => p.file.replace(/\\/g, '/') === example && p.search !== '');
  const applied: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  if (own.length === 0) return { applied, failed: [...targets], skipped };
  let exampleText = '';
  try {
    exampleText = readFileSync(path.join(root, example), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    /* образца нет — соседей не знаем */
  }
  for (const target of targets) {
    const pairs = entityPairs(glob, example, target);
    let text = '';
    try {
      text = readFileSync(path.join(root, target), 'utf8');
    } catch {
      /* нет файла — пусть решает applyPatches */
    }
    // ни одного фрагмента образца в файле и нет похожего места (тех же соседних строк) — правка к нему не относится.
    // Похожее место есть, а фрагмент другой («<h1>Адреса</h1>» против «<h1>Заказы</h1>») — это отказ: нужна модель.
    const hasPlace = (p: Patch) => {
      // в конвейере образец уже исправлен (ищем новый текст), при прямом вызове — ещё нет (ищем старый)
      const n = neighbours(exampleText, p.replace);
      const [before, after] = n[0] || n[1] ? n : neighbours(exampleText, p.search);
      // соседи вроде «</Link>» или «)}» есть везде — ничего не говорят; если различимых соседей нет, место считаем найденным
      const marks = [before, after].filter((l): l is string => !!l && l.length >= 12);
      return marks.length === 0 || marks.some((l) => present(text, l) || present(text, substitute(l, pairs)));
    };
    if (text && own.every((p) => !present(text, p.search) && !present(text, substitute(p.search, pairs)) && !hasPlace(p))) {
      skipped.push(target);
      continue;
    }
    const variants: Patch[][] = [
      own.map((p) => ({ ...p, file: target, search: substitute(p.search, pairs), replace: substitute(p.replace, pairs) })),
      own.map((p) => ({ ...p, file: target })),
    ];
    let ok = false;
    for (const v of variants) {
      if (applyPatches(root, v, frozen).ok) {
        ok = true;
        break;
      }
    }
    (ok ? applied : failed).push(target);
  }
  return { applied, failed, skipped };
}
