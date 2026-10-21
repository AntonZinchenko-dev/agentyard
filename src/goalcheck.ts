// Приёмка по цели: все задачи зелёные — но получил ли человек то, что просил?
// Задачи могут пройти проверки и при этом промахнуться мимо цели (поменяли не тот файл, сделали половину).
// Модель смотрит на итоговый diff глазами человека; если цель не достигнута — даёт задачи на доработку.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT } from './config.ts';
import { thinkFor } from './agent.ts';
import { PLAN_SCHEMA } from './plan.ts';
import { jsonObjectsIn } from './tools/shim.ts';
import type { Runtime } from './runtime/types.ts';
import type { PlannedTask } from './types.ts';

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'goalcheck', 'SKILL.md');

export const GOAL_SCHEMA = {
  type: 'object',
  required: ['achieved', 'missing', 'tasks'],
  properties: {
    achieved: { type: 'boolean' },
    missing: { type: 'array', items: { type: 'string' } },
    tasks: PLAN_SCHEMA.properties.tasks,
  },
} as const;

export interface GoalVerdict {
  /** null — модель не дала разборчивого ответа (тогда доработку не начинаем). */
  achieved: boolean | null;
  missing: string[];
  tasks: PlannedTask[];
}

export async function checkGoal(opts: {
  runtime: Runtime;
  modelTag: string;
  thinking?: 'toggle' | 'levels';
  /** Ход генерации для живой строки в окне. */
  onProgress?: (p: import('./runtime/types.ts').ChatProgress) => void;
  /** Модель на процессоре: рассуждения короче, иначе план пишется десятки минут. */
  lowThink?: boolean;
  goal: string;
  understanding?: string;
  diff: string;
  /** Полный текст изменённых небольших файлов — чтобы увидеть, что осталось нетронутым рядом с правкой. */
  files?: { file: string; text: string }[];
  human: { id: string; why: string }[];
  /** Подсказки, проверенные программой по коду (например, правку CSS перебивает более точное правило). */
  hints?: string[];
  repoMapText: string;
  numCtx: number;
  round: number;
}): Promise<GoalVerdict> {
  const system = existsSync(SKILL) ? readFileSync(SKILL, 'utf8') : 'Проверь, достигнута ли цель. Верни JSON.';
  const ask = [
    '## Цель (как написал человек)',
    opts.goal,
    ...(opts.understanding ? ['## Как её понял планировщик', opts.understanding] : []),
    '## Карта проекта',
    opts.repoMapText,
    '## Итоговые изменения (diff от состояния до прогона)',
    opts.diff.trim() ? opts.diff : '(изменений в файлах НЕТ)',
    ...(opts.files?.length ? ['## Изменённые файлы целиком (после правок) — проверь, не осталось ли рядом того, что тоже надо было поменять', ...opts.files.map((f) => `### ${f.file}\n\`\`\`\n${f.text}\n\`\`\``)] : []),
    ...(opts.hints?.length ? ['## Проверено программой по коду — это факты по ВСЕМ файлам (diff выше может быть обрезан). Если факт говорит, что старого не осталось нигде, — не пиши, что оно не заменено', opts.hints.map((h) => `- ${h}`).join('\n')] : []),
    ...(opts.human.length ? ['## Не сделано (ждёт человека)', opts.human.map((h) => `- ${h.id}: ${h.why}`).join('\n')] : []),
    '## Как ответить',
    `Верни JSON: {"achieved": true/false, "missing": ["чего не хватает"], "tasks": [задачи на доработку, id вида D${opts.round}.1, D${opts.round}.2]}. Не больше 4 задач.`,
  ].join('\n\n');
  const r = await opts.runtime.chat({
    model: opts.modelTag,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: ask },
    ],
    format: GOAL_SCHEMA as unknown as Record<string, unknown>,
    temperature: AGENT.temperaturePlan,
    numCtx: opts.numCtx,
    think: opts.lowThink ? (opts.thinking === 'levels' ? 'low' : opts.thinking ? false : undefined) : thinkFor('planner', opts.thinking),
      onProgress: opts.onProgress,
    maxTokens: AGENT.maxTokens.planner,
  });
  const parsed = jsonObjectsIn(r.message.content).find((o) => o && typeof o === 'object' && 'achieved' in (o as object)) as
    | { achieved?: unknown; missing?: unknown; tasks?: unknown }
    | undefined;
  if (!parsed || typeof parsed.achieved !== 'boolean') return { achieved: null, missing: [], tasks: [] };
  const missing = Array.isArray(parsed.missing) ? parsed.missing.map(String).filter(Boolean) : [];
  const tasks = Array.isArray(parsed.tasks) ? (parsed.tasks as PlannedTask[]).slice(0, 4) : [];
  return { achieved: parsed.achieved, missing, tasks: parsed.achieved ? [] : tasks };
}

/** Задачи доработки: свои id (D1.1…), зависимости только между собой, поля по умолчанию. */
export function normalizeFollowUps(tasks: PlannedTask[], round: number, existing: Set<string>): PlannedTask[] {
  const rename = new Map<string, string>();
  tasks.forEach((t, i) => rename.set(String(t.id ?? i + 1), `D${round}.${i + 1}`));
  return tasks.map((t, i) => {
    let id = `D${round}.${i + 1}`;
    // занят (продолжение прогона снова считает раунды с 1) — буква, а не штрихи: D1.1b, D1.1c
    if (existing.has(id)) {
      const base = id;
      for (let k = 1; existing.has(id); k++) id = `${base}${k < 26 ? String.fromCharCode(97 + k) : k}`;
    }
    return {
      id,
      type: t.type === 'test' || t.type === 'analyze' ? t.type : 'edit',
      title: String(t.title ?? 'Доработка по цели'),
      brief: String(t.brief ?? ''),
      dependsOn: (Array.isArray(t.dependsOn) ? t.dependsOn : []).map((d) => rename.get(String(d))).filter((d): d is string => !!d && d !== id),
      files: Array.isArray(t.files) ? t.files.map(String) : [],
      newFiles: Array.isArray(t.newFiles) ? t.newFiles.map(String) : undefined,
      accept: { tests: Array.isArray(t.accept?.tests) ? t.accept.tests.map(String) : [], commands: Array.isArray(t.accept?.commands) ? t.accept.commands.map(String) : [] },
      size: t.size === 'M' || t.size === 'L' ? t.size : 'S',
      ...(typeof t.similar === 'string' && t.similar ? { similar: t.similar } : {}),
      ...(Array.isArray(t.install) && t.install.length ? { install: t.install.map(String) } : {}),
    };
  });
}
