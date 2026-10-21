// Инструменты работы с файлами — только внутри папки проекта.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.agentyard', '.next', 'coverage', '__pycache__', '.venv', 'venv']);
// плюс файлы без расширения, которые часто просят поправить: Dockerfile, Makefile, .dockerignore, .env.example
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|py|go|rs|java|kt|cs|css|scss|sass|less|html|vue|svelte|yml|yaml|toml|ini|cfg|xml|txt|sql|sh|bat|ps1|php|rb|gradle|prisma|graphql|gql|env\.example)$|^(Dockerfile(\..+)?|Containerfile|Makefile|Procfile|\.dockerignore|\.gitignore|\.env\.example|\.nvmrc)$/i;

/** Превращает путь от модели в безопасный абсолютный путь внутри root. Иначе — ошибка. */
export function safePath(root: string, rel: string): string {
  const normalized = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Путь ${rel} выходит за пределы проекта`);
  }
  const abs = path.resolve(root, normalized);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`Путь ${rel} выходит за пределы проекта`);
  }
  return abs;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Все текстовые файлы проекта (относительные пути, через /). */
export function listFiles(root: string, limit = 5000): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= limit) return;
    for (const name of readdirSync(dir)) {
      if (IGNORED_DIRS.has(name)) continue;
      const abs = path.join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (TEXT_EXT.test(name) && st.size < 512_000) out.push(toPosix(path.relative(root, abs)));
      if (out.length >= limit) return;
    }
  };
  walk(root);
  return out.sort();
}

export function listDir(root: string, rel = '.'): string {
  const abs = safePath(root, rel === '.' ? '' : rel);
  if (!existsSync(abs)) return `Папки ${rel} нет.`;
  return readdirSync(abs)
    .filter((n) => !IGNORED_DIRS.has(n))
    .map((n) => (statSync(path.join(abs, n)).isDirectory() ? `${n}/` : n))
    .join('\n');
}

/** Чтение файла с номерами строк — модели так проще ссылаться на места. */
export function readFile(root: string, rel: string, from = 1, to?: number): string {
  const abs = safePath(root, rel);
  if (!existsSync(abs)) return `Файла ${rel} нет.`;
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
  const end = Math.min(to ?? lines.length, lines.length);
  return lines
    .slice(Math.max(0, from - 1), end)
    .map((l, i) => `${String(from + i).padStart(4)}| ${l}`)
    .join('\n');
}

/** Поиск строки или регулярного выражения по проекту (замена ripgrep для этапа 0). */
export function search(root: string, pattern: string, maxHits = 50): string {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  const hits: string[] = [];
  for (const f of listFiles(root)) {
    const lines = readFileSync(path.join(root, f), 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => {
      if (hits.length < maxHits && re.test(l)) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 200)}`);
    });
    if (hits.length >= maxHits) break;
  }
  return hits.length ? hits.join('\n') : 'Ничего не найдено.';
}

/** Обрезка длинного вывода инструмента с понятной пометкой. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [обрезано: ещё ${text.length - max} символов, уточни запрос]`;
}
