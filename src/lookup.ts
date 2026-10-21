// Справка по ошибке, прежде чем звать человека.
//
// 1. Локально, без сети: если ошибка типов называет тип библиотеки (MantineProviderProps, MantineTheme…),
//    программа находит его объявление в node_modules/<пакет>/**/*.d.ts — модель видит, какие свойства на самом деле есть
//    (её память о версии библиотеки устарела, а файл типов — нет).
// 2. В интернете: поиск по тексту ошибки без путей проекта (DuckDuckGo, при отказе — Bing) и выдержки
//    из первых страниц вокруг слов ошибки.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const UTILITY = new Set(['IntrinsicAttributes', 'IntrinsicClassAttributes', 'PartialObjectDeep', 'Partial', 'Record', 'Readonly', 'Pick', 'Omit', 'Required', 'ReactNode', 'ReactElement', 'JSX', 'Element', 'Promise', 'Array', 'String', 'Number', 'Boolean', 'Object', 'Function', 'Exclude', 'Extract', 'NonNullable', 'ComponentProps', 'ComponentPropsWithoutRef', 'PropsWithChildren', 'DetailedHTMLProps', 'HTMLAttributes']);

/** Имена типов из текста ошибки TypeScript: «type 'IntrinsicAttributes & MantineProviderProps'» → MantineProviderProps. */
export function typeNamesFromError(output: string): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(/type '([^']+)'/g)) {
    for (const id of m[1]!.match(/\b[A-Z][A-Za-z0-9]+\b/g) ?? []) if (!UTILITY.has(id)) out.add(id);
  }
  return [...out].slice(0, 4);
}

/** Свойства, на которые ругается ошибка: «'colorScheme' does not exist». */
export function propsFromError(output: string): string[] {
  return [...new Set([...output.matchAll(/'([A-Za-z_$][\w$]*)' does not exist|Property '([A-Za-z_$][\w$]*)'/g)].map((m) => m[1] ?? m[2]!))].slice(0, 4);
}

/** Пакеты, которые импортирует файл (только внешние). */
export function importedPackages(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:from\s+|import\s+|require\()\s*['"]([^'".][^'"]*)['"]/g)) {
    const spec = m[1]!;
    out.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);
  }
  return [...out];
}

function* dtsFiles(dir: string, budget = { n: 4000 }): Generator<string> {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (budget.n-- <= 0) return;
    const abs = path.join(dir, n);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (n === 'node_modules' || n.startsWith('.')) continue;
      yield* dtsFiles(abs, budget);
    } else if (/\.d\.(m|c)?ts$/.test(n) && st.size < 2_000_000) yield abs;
  }
}

/** Объявление типа целиком (до закрывающей скобки), не длиннее max строк. */
export function declarationIn(text: string, name: string, max = 70): string | null {
  const re = new RegExp(`^[ \\t]*(?:export\\s+)?(?:declare\\s+)?(?:interface|type)\\s+${name}\\b[^\\n]*`, 'm');
  const m = re.exec(text);
  if (!m) return null;
  const lines = text.slice(m.index).split('\n');
  let depth = 0;
  const out: string[] = [];
  for (const l of lines) {
    out.push(l);
    for (const ch of l) {
      if (ch === '{' || ch === '(' || ch === '<') depth++;
      else if (ch === '}' || ch === ')' || ch === '>') depth--;
    }
    if (out.length > 1 && depth <= 0 && /[;}]\s*$/.test(l)) break;
    if (out.length === 1 && depth <= 0 && /;\s*$/.test(l)) break;
    if (out.length >= max) {
      out.push('  … (обрезано)');
      break;
    }
  }
  return out.join('\n');
}

/** Справка из файлов типов библиотек, которые импортирует файл с ошибкой. */
export function localTypeHelp(root: string, fileText: string, output: string): string | null {
  const names = typeNamesFromError(output);
  if (!names.length) return null;
  const pkgs = importedPackages(fileText).map((p) => path.join(root, 'node_modules', p)).filter((d) => existsSync(d));
  const found: string[] = [];
  for (const name of names) {
    let hit: string | null = null;
    for (const pkg of pkgs) {
      for (const f of dtsFiles(pkg)) {
        let text = '';
        try {
          text = readFileSync(f, 'utf8');
        } catch {
          continue;
        }
        if (!text.includes(name)) continue;
        const d = declarationIn(text, name);
        if (d) {
          hit = `// ${path.relative(root, f).split(path.sep).join('/')}\n${d}`;
          break;
        }
      }
      if (hit) break;
    }
    if (hit) found.push(hit);
  }
  return found.length ? found.join('\n\n') : null;
}

/** Пакеты, в чьих файлах типов нашлись объявления (из ответа localTypeHelp). */
export function packagesOfHelp(help: string | null): string[] {
  return [...new Set([...(help ?? '').matchAll(/node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//g)].map((m) => m[1]!))];
}

/** Что импортирует файл: имя → пакет (только внешние пакеты). */
function importMap(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'".][^'"]*)['"]/g)) {
    const spec = m[2]!;
    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
    for (const id of m[1]!.replace(/\bas\s+/g, ' ').match(/[A-Za-z_$][\w$]*/g) ?? []) if (id !== 'type') out.set(id, pkg);
  }
  return out;
}

/**
 * Библиотека, о которой ошибка, — по строке кода, где она случилась: «form.setValue(...)» → form = useForm(...) → react-hook-form.
 * Ошибка «string is not assignable to never» сама по себе ничего не говорит о библиотеке, а поиск без неё находит общие статьи.
 */
export function libraryOfError(fileText: string, output: string): string | null {
  const pos = /\((\d+),\d+\)|:(\d+):\d+/.exec(output.split(/\r?\n/).find((l) => /error|TS\d{4}/i.test(l)) ?? '');
  const n = Number(pos?.[1] ?? pos?.[2] ?? 0);
  if (!n) return null;
  const lines = fileText.split(/\r?\n/);
  const imports = importMap(fileText);
  const skip = new Set(['react', 'react-dom']);
  const viaVar = (id: string): string | null => {
    // const form = useForm(...) / const { register } = useForm(...)
    const re = new RegExp(`(?:const|let|var)\\s+(?:\\{[^}]*\\b${id}\\b[^}]*\\}|${id})\\s*(?::[^=]+)?=\\s*(?:await\\s+)?([A-Za-z_$][\\w$]*)`);
    const callee = re.exec(fileText)?.[1];
    return callee ? (imports.get(callee) ?? null) : null;
  };
  for (const ln of [lines[n - 1] ?? '', lines[n] ?? '', lines[n - 2] ?? '']) {
    for (const id of ln.match(/[A-Za-z_$][\w$]*/g) ?? []) {
      const pkg = imports.get(id) ?? viaVar(id);
      if (pkg && !skip.has(pkg)) return pkg;
    }
  }
  return null;
}

/** Строка поиска по ошибке: код и текст без путей, плюс библиотека с версией. Пусто — искать в интернете нечего. */
export function errorQuery(output: string, deps: Record<string, string> = {}, libs: string[] = []): string {
  // «признаки готовности», «фрагмент не найден» — это наши проверки, а не ошибка компилятора: в интернете о них ничего нет
  const line =
    output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /error|Error|TS\d{4}|cannot|not assignable|does not exist|is not|unexpected|expected/i.test(l) && !/^Новые ошибки|^Ступень|^Команда:/.test(l)) ?? '';
  if (!line) return '';
  const clean = line
    .replace(/^[^\s]*\.(tsx?|jsx?|py|go|rs|java|cs|php|rb|vue)(\(\d+,\d+\)|:\d+(:\d+)?)?:?\s*/i, '')
    .replace(/[A-Za-z]:\\[^\s'"]+|\/[\w./-]+\/[\w.-]+/g, '')
    .replace(/\{[^{}]{60,}\}/g, '{…}')
    .replace(/\s+/g, ' ')
    .slice(0, 180);
  // библиотека, о которой ошибка: её имя (или имя организации @mantine) встречается в тексте ошибки
  const low = output.toLowerCase();
  const key = (name: string) => (name.startsWith('@') ? name.slice(1).split('/')[0]! : name).toLowerCase();
  let lib = Object.entries(deps)
    .filter(([name]) => key(name).length >= 3 && low.includes(key(name)))
    .sort((a, b) => Number(key(a[0]) === 'react') - Number(key(b[0]) === 'react') || key(b[0]).length - key(a[0]).length)[0];
  // в тексте ошибки библиотеки нет — та, где объявлен тип из ошибки, или та, чей вызов в строке с ошибкой
  if (!lib) {
    const name = libs.find((l) => l in deps) ?? libs[0];
    if (name) lib = [name, deps[name] ?? ''];
  }
  const ver = lib ? String(lib[1]).replace(/^[^\d]*/, '').split('.')[0] : '';
  return `${clean}${lib ? ` ${lib[0]}${ver ? ` ${ver}` : ''}` : ''}`.trim();
}

export interface WebHit {
  title: string;
  url: string;
  snippet: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function decode(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function get(url: string, ms: number): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en,ru;q=0.8' }, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

export function parseDuckDuckGo(html: string): WebHit[] {
  const out: WebHit[] = [];
  const links = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  links.forEach((m, i) => {
    let url = m[1]!.replace(/&amp;/g, '&');
    const u = /[?&]uddg=([^&]+)/.exec(url);
    if (u) url = decodeURIComponent(u[1]!);
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https?:/.test(url) || /duckduckgo\.com\/y\.js/.test(url)) return;
    // описание — между этой ссылкой и следующей
    const rest = html.slice(m.index! + m[0].length, links[i + 1]?.index ?? html.length);
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/(a|div|td)>/.exec(rest);
    out.push({ title: decode(m[2]!), url, snippet: decode(sn?.[1] ?? '') });
  });
  return out;
}

/**
 * Bing отдаёт ссылки через свой переход (bing.com/ck/a?…&u=a1<base64>) — страница по такой ссылке не открывается программой
 * (прогон 20261020112744: 6 ссылок, 0 выдержек). Настоящий адрес — в параметре u после «a1», в base64url.
 */
export function bingTarget(url: string): string {
  const m = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(url.replace(/&amp;/g, '&'));
  if (!m) return url;
  try {
    const real = Buffer.from(m[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    if (/^https?:\/\/[^\s]+$/.test(real)) return real;
  } catch {
    /* не base64 */
  }
  return url;
}

export function parseBing(html: string): WebHit[] {
  const out: WebHit[] = [];
  const items = html.split('<li class="b_algo"').slice(1);
  for (const it of items) {
    const a = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(it);
    if (!a) continue;
    const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(it);
    out.push({ title: decode(a[2]!), url: bingTarget(a[1]!.replace(/&amp;/g, '&')), snippet: decode(p?.[1] ?? '') });
  }
  return out;
}

const STOP = new Set(['error', 'type', 'with', 'that', 'this', 'from', 'have', 'does', 'not', 'the', 'and', 'for', 'into', 'only', 'may', 'can', 'argument', 'parameter']);

/**
 * Ссылка по делу: в заголовке, описании или адресе есть код ошибки, или библиотека, или хотя бы два значимых слова из запроса.
 * Мусорные выдачи (страницы о «готовности ребёнка к школе» на запрос «признаки готовности») отсекаются.
 */
export function relevantHits(hits: WebHit[], query: string): WebHit[] {
  const code = /\bTS(\d{4})\b/i.exec(query)?.[1];
  const words = [...new Set((query.toLowerCase().match(/[a-z@][a-z0-9@/._-]{3,}/g) ?? []).filter((w) => !STOP.has(w)))];
  return hits.filter((h) => {
    const text = `${h.title} ${h.snippet} ${h.url}`.toLowerCase();
    if (code && text.includes(code)) return true;
    return words.filter((w) => text.includes(w)).length >= 2;
  });
}
/** Поиск в интернете без ключей: DuckDuckGo, при отказе — Bing. */
export async function webSearch(query: string, ms = 10_000): Promise<WebHit[]> {
  const q = encodeURIComponent(query);
  try {
    const hits = relevantHits(parseDuckDuckGo(await get(`https://html.duckduckgo.com/html/?q=${q}`, ms)), query);
    if (hits.length) return hits.slice(0, 6);
  } catch {
    /* попробуем другой поисковик */
  }
  try {
    return relevantHits(parseBing(await get(`https://www.bing.com/search?q=${q}&setlang=en`, ms)), query).slice(0, 6);
  } catch {
    return [];
  }
}

/** Выдержка со страницы вокруг слов ошибки (свойство, тип, код ошибки). */
export function excerpt(html: string, terms: string[], max = 1400): string {
  const text = decode(html.replace(/<(script|style|nav|header|footer|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<(br|p|li|div|h\d|pre|tr)[^>]*>/gi, '\n'));
  const lower = text.toLowerCase();
  const parts: string[] = [];
  let used = 0;
  for (const t of terms.filter(Boolean)) {
    let at = lower.indexOf(t.toLowerCase());
    let n = 0;
    while (at >= 0 && n < 2 && used < max) {
      const piece = text.slice(Math.max(0, at - 250), at + 450).trim();
      if (!parts.some((p) => p.includes(piece.slice(50, 120)))) {
        parts.push(`…${piece}…`);
        used += piece.length;
      }
      at = lower.indexOf(t.toLowerCase(), at + 450);
      n++;
    }
  }
  return parts.join('\n').slice(0, max);
}

export async function pageExcerpt(url: string, terms: string[], ms = 8000): Promise<string> {
  try {
    return excerpt(await get(url, ms), terms);
  } catch {
    return '';
  }
}
