// Каталог моделей: стартовые оценки пригодности к ролям.
// Файл catalog/models.json можно обновлять без изменения кода.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { CatalogModel } from './types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CATALOG_PATH = path.join(here, '..', 'catalog', 'models.json');

export function loadCatalog(file = CATALOG_PATH): CatalogModel[] {
  return JSON.parse(readFileSync(file, 'utf8')) as CatalogModel[];
}

/** Сопоставляет тег из Ollama с записью каталога ("qwen3.6:latest" → qwen3.6). */
export function findByTag(catalog: CatalogModel[], tag: string): CatalogModel | undefined {
  const norm = (t: string) => t.replace(/:latest$/, '');
  const exact = catalog.find((m) => norm(m.ollamaTag) === norm(tag));
  if (exact) return exact;
  // вариант сжатия: "qwen2.5-coder:7b-instruct-q8_0" → запись "qwen2.5-coder:7b"
  return catalog
    .filter((m) => m.ollamaTag.includes(':') && norm(tag).startsWith(`${m.ollamaTag}-`))
    .sort((a, b) => b.ollamaTag.length - a.ollamaTag.length)[0];
}

/**
 * Модель, которой нет в каталоге, всё равно можно использовать —
 * с осторожными средними оценками, пока статистика не накопится.
 */
export function unknownModel(tag: string, sizeGb: number): CatalogModel {
  return {
    id: tag,
    ollamaTag: tag,
    paramsTotalB: 0,
    paramsActiveB: 0,
    memoryGbQ4: sizeGb,
    license: 'unknown',
    toolCalling: true,
    contextMax: 32_768,
    roles: { scout: 0.5, reporter: 0.5, analyst: 0.4, coder: 0.4, tester: 0.4, reviewer: 0.4, planner: 0.4 },
  };
}
