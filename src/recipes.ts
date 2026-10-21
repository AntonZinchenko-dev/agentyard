// Рецепты — навыки для типовых задач (skills/recipes/*.md). Маленькая модель не знает, как правильно
// подключить UI-кит в Next.js или поменять порт во всех местах; проверенный рецепт в запросе планировщика это закрывает.
// Формат файла: строка «триггер: <регулярка по цели>», строка «проект: <регулярка по пакетам проекта>», «---», текст.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'recipes');

export interface Recipe {
  name: string;
  trigger: RegExp;
  project: RegExp;
  text: string;
}

export function loadRecipes(dir = DIR): Recipe[] {
  if (!existsSync(dir)) return [];
  const out: Recipe[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const raw = readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');
    const [head, ...rest] = raw.split('\n---\n');
    const trig = /^триггер:\s*(.+)$/m.exec(head ?? '')?.[1];
    const proj = /^проект:\s*(.+)$/m.exec(head ?? '')?.[1] ?? '.*';
    if (!trig || !rest.length) continue;
    try {
      out.push({ name: f.replace(/\.md$/, ''), trigger: new RegExp(trig, 'i'), project: new RegExp(proj, 'i'), text: rest.join('\n---\n').trim() });
    } catch {
      /* битая регулярка в рецепте — пропускаем его */
    }
  }
  return out;
}

/**
 * Рецепты, подходящие к цели и проекту (по тегам стека: языки, фреймворки, пакеты).
 * Строки вида «@регулярка: текст» остаются, только если регулярка подходит к тегам проекта:
 * так один рецепт («новый эндпоинт») говорит про Express, FastAPI, Spring… но модель видит только своё.
 */
export function pickRecipes(goal: string, tags: string[], recipes = loadRecipes(), max = 3): Recipe[] {
  const t = tags.join(' ') || '-';
  return recipes
    .filter((r) => r.trigger.test(goal) && r.project.test(t))
    .map((r) => ({ ...r, text: forProject(r.text, t) }))
    .slice(0, max);
}

export function forProject(text: string, tags: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^@(.+?):\s(.*)$/.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    try {
      if (new RegExp(m[1]!, 'i').test(tags)) out.push(m[2]!);
    } catch {
      /* битая регулярка — строку пропускаем */
    }
  }
  return out.join('\n');
}
