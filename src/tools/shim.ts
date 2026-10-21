// «Прокладка» для слабых моделей.
// 1) Модель написала вызов инструмента текстом (JSON в ответе) — достаём его.
// 2) Модель прислала аргументы в «чужой» форме (строка JSON, другие имена полей) — приводим к нашей.

import type { ToolCall } from '../runtime/types.ts';
import type { Patch } from '../types.ts';

/** Все JSON-объекты верхнего уровня в тексте: в ```-блоках и просто в тексте. */
export function jsonObjectsIn(text: string): unknown[] {
  const out: unknown[] = [];
  const tryParse = (s: string) => {
    try {
      out.push(JSON.parse(s));
      return true;
    } catch {
      return false;
    }
  };
  if (tryParse(text.trim())) return out;

  // поиск сбалансированных {...} с учётом строк
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          if (tryParse(text.slice(i, j + 1))) i = j;
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Вызовы инструментов, записанные текстом. Понимаем формы:
 *   {"name": "...", "arguments": {...}}  · {"name": "...", "parameters": {...}}
 *   {"function": {"name": "...", "arguments": {...}}}  · {"tool": "...", "args": {...}}
 *   и голый ответ {"patches": [...]} / {"verdict": ...} / {"brief": ...} — как сдачу работы.
 */
export function extractToolCalls(content: string, allowed: string[], submitName: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const obj of jsonObjectsIn(content)) {
    if (!obj || typeof obj !== 'object') continue;
    const o = obj as Record<string, unknown>;
    const fn = (o.function as Record<string, unknown> | undefined) ?? o;
    const name = String(fn.name ?? fn.tool ?? fn.tool_name ?? '');
    const args = fn.arguments ?? fn.parameters ?? fn.args ?? fn.input;
    if (name && allowed.includes(name)) {
      calls.push({ function: { name, arguments: toObject(args) } });
      continue;
    }
    // голый ответ без имени инструмента
    if ('patches' in o || 'verdict' in o || 'brief' in o) {
      calls.push({ function: { name: submitName, arguments: o } });
    }
  }
  return calls;
}

function toObject(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

const FILE_KEYS = ['file', 'path', 'filename', 'file_path', 'filepath'];
const SEARCH_KEYS = ['search', 'find', 'old', 'old_str', 'old_string', 'original', 'before'];
const REPLACE_KEYS = ['replace', 'new', 'new_str', 'new_string', 'updated', 'after', 'replacement'];

const pickStr = (o: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const k of keys) if (typeof o[k] === 'string') return o[k] as string;
  return undefined;
};

/** Приводит аргументы submit_patches к списку заплаток, как бы модель их ни записала. */
export function normalizePatches(args: Record<string, unknown>): Patch[] {
  let raw: unknown = args.patches ?? args.patch ?? args.changes ?? args.edits;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = undefined;
    }
  }
  // заплатка прямо в аргументах, без обёртки patches
  if (raw === undefined && pickStr(args, FILE_KEYS) !== undefined) raw = [args];
  if (raw && !Array.isArray(raw) && typeof raw === 'object') raw = [raw];
  if (!Array.isArray(raw)) return [];

  const out: Patch[] = [];
  for (const item of raw) {
    let p: unknown = item;
    if (typeof p === 'string') {
      try {
        p = JSON.parse(p);
      } catch {
        continue;
      }
    }
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    const file = pickStr(o, FILE_KEYS);
    const replace = pickStr(o, REPLACE_KEYS);
    if (!file || replace === undefined) continue;
    const all = o.all === true || o.replace_all === true || o.replaceAll === true || o.all === 'true';
    out.push({ file, search: pickStr(o, SEARCH_KEYS) ?? '', replace, ...(all ? { all: true } : {}) });
  }
  return out;
}

/**
 * Модели часто копируют строки из read_file вместе с номерами «  12| ».
 * Если КАЖДАЯ непустая строка фрагмента начинается так — номера срезаем.
 */
export function stripLineNumbers(s: string): string {
  const lines = s.split('\n');
  const re = /^\s*\d+\| ?/;
  const nonEmpty = lines.filter((l) => l.trim());
  if (nonEmpty.length === 0 || !nonEmpty.every((l) => re.test(l))) return s;
  return lines.map((l) => l.replace(re, '')).join('\n');
}
