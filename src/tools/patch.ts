// Заплатки «найди — замени». Применяются, только если фрагмент найден ровно один раз.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { safePath } from './fs.ts';
import type { Patch } from '../types.ts';

export interface PatchResult {
  ok: boolean;
  errors: string[];
  changedFiles: string[];
  changedLines: number;
}

/** Небольшой файл можно переписать целиком (пустой search); большой — только фрагментами, чтобы модель не потеряла код. */
export const REWRITE_MAX_LINES = 300;
/** Стили, разметка и тексты: правка меняет много строк, но не логику — у них свой, больший лимит. */
export const ASSET_RE = /\.(css|scss|sass|less|md|mdx|html|svg|txt)$/i;
export const ASSET_MAX_LINES = 400;

/**
 * Применяет набор заплаток атомарно: если хоть одна не подошла — файлы не трогаются.
 * Пустой search: нового файла — создать; существующего небольшого — переписать целиком.
 * changedLines считает строки кода; строки стилей и разметки идут в лимит, только если их больше ASSET_MAX_LINES.
 */
export function applyPatches(root: string, patches: Patch[], frozen: string[] = [], overwritable: string[] = []): PatchResult {
  const errors: string[] = [];
  const next = new Map<string, string>();
  let codeLines = 0;
  let assetLines = 0;

  for (const [i, p] of patches.entries()) {
    const label = `Заплатка ${i + 1} (${p.file})`;
    let abs: string;
    try {
      abs = safePath(root, p.file);
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`);
      continue;
    }
    const rel = p.file.replace(/\\/g, '/').replace(/^\.\//, '');
    if (frozen.includes(rel)) {
      errors.push(`${label}: этот файл заморожен — его менять нельзя, правь код, а не тест.`);
      continue;
    }

    const current = next.get(abs) ?? (existsSync(abs) ? readFileSync(abs, 'utf8') : null);

    const isAsset = ASSET_RE.test(rel);
    const count_ = (n: number) => {
      if (isAsset) assetLines += n;
      else codeLines += n;
    };
    if (p.search === '') {
      // пустой search у существующего файла — переписать целиком; можно для своих новых файлов и для небольших
      const lines = current === null ? 0 : current.split('\n').length;
      // gpt-oss иногда экранирует переводы строк дважды: весь файл встаёт одной строкой с буквальными \n (прогон 20.10 02:50)
      const replace = unescapeFlat(p.replace);
      if (current !== null && current.trim() && !replace.trim()) {
        errors.push(`${label}: пустой replace при пустом search стирает весь файл. Если в этом файле менять нечего — не присылай для него заплатку; если правка нужна — укажи фрагмент в search.`);
        continue;
      }
      if (current !== null && current.length > 0 && !overwritable.includes(rel) && lines > REWRITE_MAX_LINES) {
        errors.push(`${label}: файл большой (${lines} строк) — целиком его переписывать нельзя. Укажи фрагмент для замены.`);
        continue;
      }
      // переписали файл с кодом целиком и потеряли больше половины строк — почти наверняка модель «сократила» файл
      const newLines = replace.split('\n').length;
      if (current && !overwritable.includes(rel) && lines >= 20 && newLines < lines * 0.5) {
        errors.push(`${label}: в новом тексте ${newLines} строк вместо ${lines} — похоже, часть файла потеряна. Пришли файл целиком без сокращений («…» и «остальное без изменений» нельзя) или правь фрагментом.`);
        continue;
      }
      next.set(abs, replace);
      // файл целиком (так просит и сама программа после промахов заплаток) — в лимит идут реально изменённые строки,
      // а не длина файла: иначе 90-строчная страница всегда «больше лимита» (прогон 20261020053801)
      count_(current && !overwritable.includes(rel) ? changedLineCount(current, replace) : newLines);
      continue;
    }
    if (current === null) {
      errors.push(`${label}: файла нет. Чтобы создать файл, оставь search пустым.`);
      continue;
    }
    // модели часто путают окончания строк — сравниваем без \r
    const text = current.replace(/\r\n/g, '\n');
    let search = p.search.replace(/\r\n/g, '\n');
    let replacement = p.replace;
    let count = text.split(search).length - 1;
    if (count === 0 && unescapeFlat(search) !== search && text.includes(unescapeFlat(search))) {
      // фрагмент с буквальными \n вместо переводов строк — та же двойная экранировка
      search = unescapeFlat(search);
      replacement = unescapeFlat(replacement);
      count = text.split(search).length - 1;
    } else if (search.includes('\n')) replacement = unescapeFlat(replacement);
    if (p.all) {
      if (count === 0) {
        errors.push(`${label}: фрагмент не найден ни разу. Для all: true скопируй его из файла точно.`);
        continue;
      }
      next.set(abs, text.split(search).join(replacement));
      // однострочная замена по всему файлу (<th> → <Table.Th>) — одно механическое правило, а не десятки правок
      count_(search.includes('\n') ? count * Math.max(search.split('\n').length, replacement.split('\n').length) : 1);
      continue;
    }
    if (count === 0) {
      // мягкое совпадение: те же строки, но с другими отступами или пробелами в конце
      const fuzzy = fuzzyReplace(text, search, replacement);
      if (fuzzy.kind === 'one') {
        next.set(abs, fuzzy.text);
        count_(Math.max(search.split('\n').length, p.replace.split('\n').length));
        continue;
      }
      errors.push(
        fuzzy.kind === 'many'
          ? `${label}: фрагмент встречается несколько раз (без учёта отступов). Добавь соседние строки, чтобы он стал уникальным.`
          : `${label}: фрагмент не найден. Скопируй его из файла точно, с пробелами и отступами.${text.split('\n').length <= REWRITE_MAX_LINES ? ' Или пришли файл целиком: search пустой, в replace — весь новый текст файла.' : ''}`,
      );
      continue;
    }
    if (count > 1) {
      errors.push(`${label}: фрагмент встречается ${count} раз. Добавь соседние строки, чтобы он стал уникальным, или поставь all: true, если заменить надо каждое вхождение.`);
      continue;
    }
    next.set(abs, text.replace(search, () => replacement));
    count_(Math.max(search.split('\n').length, replacement.split('\n').length));
  }

  if (errors.length) return { ok: false, errors, changedFiles: [], changedLines: 0 };
  // заплатки, которые ничего не меняют (search === replace), — не работа: файл не трогаем и не считаем изменённым
  for (const [abs, content] of [...next]) {
    const before = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    if (before !== null && before.replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n')) next.delete(abs);
  }
  if (next.size === 0) return { ok: false, errors: ['Заплатки ничего не меняют: новый текст совпадает со старым. Сделай нужную правку.'], changedFiles: [], changedLines: 0 };
  const changedLines = codeLines + Math.max(0, assetLines - ASSET_MAX_LINES);

  for (const [abs, content] of next) {
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return {
    ok: true,
    errors: [],
    changedFiles: [...next.keys()].map((a) => path.relative(root, a).split(path.sep).join('/')),
    changedLines,
  };
}

/**
 * Текст без единого перевода строки, но с буквальными «\n» (два и больше) — модель экранировала дважды.
 * Возвращаем настоящие переводы строк, табуляции и кавычки. Однострочный код с одной «\n» внутри строки не трогаем.
 */
export function unescapeFlat(s: string): string {
  if (s.includes('\n') || (s.match(/\\n/g) ?? []).length < 2) return s;
  return s.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
}

type Fuzzy = { kind: 'none' } | { kind: 'many' } | { kind: 'one'; text: string };

/**
 * Ищет фрагмент построчно, сравнивая строки без начальных и конечных пробелов.
 * Если нашёлся ровно один — заменяет эти строки, сдвинув отступ замены так же,
 * как модель ошиблась с отступом фрагмента (например, написала 6 пробелов вместо 4).
 */
export function fuzzyReplace(text: string, search: string, replace: string): Fuzzy {
  const fileLines = text.split('\n');
  const sLines = trimEmptyEdges(search.split('\n'));
  if (sLines.length === 0 || sLines.every((l) => !l.trim())) return { kind: 'none' };

  const hits: number[] = [];
  for (let i = 0; i + sLines.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < sLines.length; j++) {
      if (fileLines[i + j]!.trim() !== sLines[j]!.trim()) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  if (hits.length === 0) return { kind: 'none' };
  if (hits.length > 1) return { kind: 'many' };

  const at = hits[0]!;
  const firstSearch = sLines.find((l) => l.trim())!;
  const firstFile = fileLines[at + sLines.indexOf(firstSearch)]!;
  const delta = indentOf(firstFile) - indentOf(firstSearch);
  const rLines = trimEmptyEdges(replace.split('\n')).map((l) => reindent(l, delta));
  const out = [...fileLines.slice(0, at), ...rLines, ...fileLines.slice(at + sLines.length)];
  return { kind: 'one', text: out.join('\n') };
}

function trimEmptyEdges(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a]!.trim()) a++;
  while (b > a && !lines[b - 1]!.trim()) b--;
  return lines.slice(a, b);
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function reindent(line: string, delta: number): string {
  if (!line.trim() || delta === 0) return line;
  if (delta > 0) return ' '.repeat(delta) + line;
  const cut = Math.min(-delta, indentOf(line));
  return line.slice(cut);
}

/** Сколько строк реально изменено, когда файл прислан целиком: удалённые и добавленные строки без учёта порядка. */
export function changedLineCount(before: string, after: string): number {
  const left = new Map<string, number>();
  for (const l of before.replace(/\r\n/g, '\n').split('\n')) left.set(l.trimEnd(), (left.get(l.trimEnd()) ?? 0) + 1);
  let added = 0;
  for (const l of after.replace(/\r\n/g, '\n').split('\n')) {
    const k = l.trimEnd();
    const c = left.get(k) ?? 0;
    if (c > 0) left.set(k, c - 1);
    else added++;
  }
  const removed = [...left.values()].reduce((a, b) => a + b, 0);
  return Math.max(added, removed);
}
