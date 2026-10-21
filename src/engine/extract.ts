// Текст из документов и данных — для задач не про код (краткое содержание, разбор, извлечение данных).
// Без внешних библиотек: docx/xlsx/pptx/odt — это zip с XML внутри (читаем zip сами через zlib),
// html — без тегов, pdf — по возможности (текст из потоков страниц; скан или хитрые шрифты не прочитаются — так и говорим).

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

export interface Extracted {
  text: string;
  /** Как получен: «docx», «pdf (частично)»… */
  how: string;
  /** Что не так (не удалось, прочитано частично). */
  note?: string;
}

/** Файлы, которые читаются как есть. */
const PLAIN = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|ya?ml|log|ini|toml|sql|[cm]?[jt]sx?|py|go|rs|java|kt|cs|php|rb|css|scss|sh|ps1|bat)$/i;

/** Файлы, которые программа умеет читать как исходные материалы. */
export const READABLE = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|ya?ml|log|html?|docx|xlsx|pptx|odt|pdf|rtf)$/i;

function decodeText(buf: Buffer): string {
  const utf8 = buf.toString('utf8').replace(/^﻿/, '');
  const bad = (utf8.match(/�/g) ?? []).length;
  if (bad > Math.max(3, utf8.length / 200)) {
    // старые выгрузки из Windows — cp1251
    try {
      return new TextDecoder('windows-1251').decode(buf);
    } catch {
      /* нет ICU — оставляем как есть */
    }
  }
  return utf8;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h\d|section|article|table|ul|ol)>/gi, '\n')
      .replace(/<(td|th)[^>]*>/gi, '\t')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Файлы из zip-архива: имя → содержимое. Только «stored» и «deflate» — этого хватает офисным форматам. */
export function unzip(buf: Buffer, want: (name: string) => boolean = () => true): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // конец центрального каталога ищем с конца (там может быть комментарий)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('это не zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count && p + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + size);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, inflateRawSync(data));
  }
  return out;
}

function docxText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function xlsxText(files: Map<string, Buffer>): string {
  const shared: string[] = [];
  const ss = files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  for (const si of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(decodeEntities(si[1]!.replace(/<[^>]+>/g, '')));
  const sheets = [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  const out: string[] = [];
  for (const [i, name] of sheets.entries()) {
    const xml = files.get(name)!.toString('utf8');
    out.push(`## Лист ${i + 1}`);
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1]!.matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]!;
        const inner = c[2] ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? '';
        const col = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
        const idx = col ? [...col].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : cells.length;
        while (cells.length < idx) cells.push('');
        cells.push(/t="s"/.test(attrs) ? (shared[Number(v)] ?? '') : decodeEntities(v));
      }
      out.push(cells.map((x) => (/[;"\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)).join(';'));
    }
  }
  return out.join('\n');
}

/** Текст из PDF: потоки страниц (Flate), операторы Tj / TJ / '. Без шрифтовых таблиц — для «простых» PDF. */
export function pdfText(buf: Buffer): { text: string; partial: boolean } {
  const src = buf.toString('latin1');
  const chunks: string[] = [];
  let partial = false;
  for (const m of src.matchAll(/<<([^]*?)>>\s*stream\r?\n/g)) {
    const dict = m[1]!;
    const start = m.index! + m[0].length;
    const end = src.indexOf('endstream', start);
    if (end < 0) continue;
    let data = buf.subarray(start, end);
    if (/FlateDecode/.test(dict)) {
      try {
        data = inflateSync(data);
      } catch {
        partial = true;
        continue;
      }
    } else if (/\/Filter/.test(dict)) {
      partial = true;
      continue;
    }
    const s = data.toString('latin1');
    if (!/\bT[Jj]\b|'/.test(s)) continue;
    const lines: string[] = [];
    for (const op of s.matchAll(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^)\\]|\\.)*)\)\s*(?:Tj|')|(T\*|Td|TD|ET)/g)) {
      if (op[3]) {
        lines.push('\n');
        continue;
      }
      const raw = op[1] !== undefined ? [...op[1].matchAll(/\(((?:[^)\\]|\\.)*)\)/g)].map((x) => x[1]!).join('') : op[2]!;
      lines.push(
        raw
          .replace(/\\([nrtbf()\\])/g, (_, c: string) => ({ n: '\n', r: '', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' })[c] ?? c)
          .replace(/\\(\d{1,3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8))),
      );
    }
    chunks.push(lines.join('').replace(/\n{2,}/g, '\n'));
  }
  // латиница из latin1; кириллица в таких PDF обычно в cp1251
  let text = chunks.join('\n').trim();
  if (/[\xC0-\xFF]{3,}/.test(text)) {
    try {
      text = new TextDecoder('windows-1251').decode(Buffer.from(text, 'latin1'));
    } catch {
      /* без ICU */
    }
  }
  return { text, partial };
}

/** Текст файла для исполнителя. null — формат не читается. */
export function extractText(abs: string): Extracted | null {
  const ext = path.extname(abs).toLowerCase();
  let buf: Buffer;
  try {
    if (statSync(abs).size > 60 * 1024 * 1024) return { text: '', how: ext.slice(1), note: 'файл больше 60 МБ — не читаю' };
    buf = readFileSync(abs);
  } catch (e) {
    return { text: '', how: ext.slice(1), note: `не открылся: ${(e as Error).message}` };
  }
  try {
    if (/\.html?$/.test(ext)) return { text: htmlToText(decodeText(buf)), how: 'html' };
    if (ext === '.rtf') return { text: decodeText(buf).replace(/\\par[d]?/g, '\n').replace(/\{\\[^{}]*\}|\\[a-z]+-?\d* ?|[{}]/g, '').trim(), how: 'rtf' };
    if (ext === '.docx') {
      const f = unzip(buf, (n) => n === 'word/document.xml');
      return { text: docxText(f.get('word/document.xml')?.toString('utf8') ?? ''), how: 'docx' };
    }
    if (ext === '.odt') {
      const f = unzip(buf, (n) => n === 'content.xml');
      return { text: docxText((f.get('content.xml')?.toString('utf8') ?? '').replace(/<\/text:(p|h)>/g, '</w:p>')), how: 'odt' };
    }
    if (ext === '.xlsx') return { text: xlsxText(unzip(buf, (n) => n.startsWith('xl/'))), how: 'xlsx (листы через ;)' };
    if (ext === '.pptx') {
      const f = unzip(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
      const slides = [...f.keys()].sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
      return { text: slides.map((n, i) => `## Слайд ${i + 1}\n${decodeEntities(f.get(n)!.toString('utf8').replace(/<\/a:p>/g, '\n').replace(/<[^>]+>/g, '')).trim()}`).join('\n\n'), how: 'pptx' };
    }
    if (ext === '.pdf') {
      const r = pdfText(buf);
      if (r.text.replace(/\s/g, '').length < 40) return { text: r.text, how: 'pdf', note: 'текст из PDF не извлёкся: похоже на скан или шрифты без таблиц символов — сохрани документ как .docx или .txt' };
      return { text: r.text, how: r.partial ? 'pdf (частично)' : 'pdf', ...(r.partial ? { note: 'часть страниц PDF не прочиталась' } : {}) };
    }
    if (PLAIN.test(abs)) return { text: decodeText(buf), how: 'текст' };
  } catch (e) {
    return { text: '', how: ext.slice(1), note: `не прочитался: ${(e as Error).message}` };
  }
  return null;
}

/** Нарезка большого текста на куски по абзацам (для «карта — свёртка»: каждую часть пересказывают отдельно, потом собирают итог). */
export function chunkText(text: string, size: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const para of text.split(/\n{2,}|\n(?=#)/)) {
    if (cur && cur.length + para.length + 2 > size) {
      out.push(cur);
      cur = '';
    }
    if (para.length > size) {
      for (let i = 0; i < para.length; i += size) out.push(para.slice(i, i + size));
      continue;
    }
    cur = cur ? `${cur}\n\n${para}` : para;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
