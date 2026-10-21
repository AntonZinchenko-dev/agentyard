// «На чём споткнулись»: вместо простыни вывода — конкретная ошибка, место, что пробовали и что нужно от человека.
// Человек вставляет решение (кусок кода или пару слов), и оно уходит исполнителю следующей попыткой.

import type { Task } from '../types.ts';
import type { AttemptLog } from './policy.ts';

export interface StumbleError {
  /** Файл и строка: web/app/layout.tsx:12 */
  where?: string;
  text: string;
}

export interface Stumble {
  /** Где остановились: «Проверка типов», «Ревью», «Признаки готовности»… */
  stage: string;
  /** Одна фраза: в чём дело. */
  summary: string;
  errors: StumbleError[];
  /** Что уже пробовали (по попыткам). */
  tried: string[];
  /** Что именно нужно от человека. */
  need: string;
}

const STAGE_NAMES: Record<string, string> = {
  '2': 'Границы и признаки готовности',
  '3': 'Синтаксис',
  '4': 'Линтер',
  '5': 'Проверка типов',
  '6': 'Тесты и команды',
};

const CLS_TEXT: Record<string, string> = {
  own: 'ошибка в файлах задачи',
  collateral: 'правка сломала другие файлы',
  environment: 'мешает окружение',
  format: 'ответ модели не по формату',
  infra: 'модель не ответила',
  review: 'вернул ревьюер',
  conflict: 'конфликт с другими правками',
};

/** Строки ошибок с местом: tsc, eslint, go, python, node. */
export function errorsWithPlace(output: string, max = 6): StumbleError[] {
  const out: StumbleError[] = [];
  const seen = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(Новые ошибки|Ступень \d|Команда:|ПОДСКАЗКА:)/.test(line)) continue;
    let m: RegExpExecArray | null;
    let e: StumbleError | null = null;
    if ((m = /^(.+?\.[\w]+)\((\d+),\d+\):\s*(?:error\s*)?(.+)$/.exec(line))) e = { where: `${norm(m[1]!)}:${m[2]}`, text: m[3]! };
    else if ((m = /^(.+?\.[\w]+):(\d+):\d+:?\s*(?:error\s*)?(.+)$/.exec(line))) e = { where: `${norm(m[1]!)}:${m[2]}`, text: m[3]! };
    else if ((m = /File "(.+?)", line (\d+)/.exec(line))) e = { where: `${norm(m[1]!)}:${m[2]}`, text: line };
    else if (/\berror\b|Error:|FAIL|not ok|✕|×|AssertionError|expected/i.test(line)) e = { text: line };
    if (!e) continue;
    const key = `${e.where ?? ''}|${e.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    e.text = e.text.replace(/^(error\s*)?:?\s*/i, '').slice(0, 300);
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

const norm = (f: string) => f.replace(/\\/g, '/').replace(/^.*?\.agentyard\/worktrees\/[^/]+\//, '');

function stageOfError(text: string, sig?: string): string {
  const m = /^Ступень (\d) \(([^)]+)\)/m.exec(text);
  if (m) return STAGE_NAMES[m[1]!] ?? m[2]!;
  if (sig?.startsWith('review:') || /^Ревью вернуло/m.test(text)) return 'Ревью';
  if (/Конфликт при слиянии/.test(text)) return 'Слияние';
  if (/^\d:/.test(sig ?? '')) return STAGE_NAMES[sig![0]!] ?? 'Проверки';
  return 'Работа исполнителя';
}

/** Описание остановки задачи для панели. null — задача ещё не спотыкалась. */
export function describeStumble(t: Task, humanWhy?: string): Stumble | null {
  const text = t.lastError ?? '';
  const log: AttemptLog[] = t.attemptLog ?? [];
  if (!text && !log.length && !humanWhy) return null;
  const last = log.at(-1);
  const stage = stageOfError(text, last?.sig ?? t.failures.at(-1));
  let errors = errorsWithPlace(text);
  // ревью: причины ревьюера — это и есть «ошибки»
  if (stage === 'Ревью') errors = text.split('\n').filter((l) => /^- /.test(l)).map((l) => ({ text: l.slice(2).trim().slice(0, 300) })).slice(0, 6);
  // признаки готовности: чего не хватает в файле
  if (!errors.length && /Правка сделана не целиком|ещё осталось|нет `/.test(text)) {
    errors = text.split('\n').filter((l) => /: (ещё осталось|нет )/.test(l)).map((l) => {
      const [file, ...rest] = l.split(': ');
      return { where: file, text: rest.join(': ') };
    }).slice(0, 6);
  }
  const head = errors[0];
  const summary = humanWhy && !text
    ? humanWhy
    : head
      ? `${stage}: ${head.where ? `${head.where} — ` : ''}${head.text}`.slice(0, 260)
      : `${stage}: ${(text.split('\n').find((l) => l.trim() && !/^Ступень/.test(l)) ?? humanWhy ?? '').trim().slice(0, 240)}`;
  const tried = log.map((a, i) => {
    const cls = CLS_TEXT[a.cls] ?? a.cls;
    const st = a.stage ? `, ${STAGE_NAMES[String(a.stage)] ?? `ступень ${a.stage}`}` : '';
    const errs = a.errors ? `, ошибок: ${a.errors}` : '';
    return `${i + 1}. ${a.model ?? 'модель'} — ${cls}${st}${errs}`;
  });
  const cls = last?.cls;
  const need =
    cls === 'environment'
      ? 'Мешает окружение, а не код: настрой его (поставь пакет, утилиту) или напиши, как обойтись без этого.'
      : stage === 'Ревью'
        ? 'Ревьюер против. Если он прав — подскажи, как сделать иначе. Если неправ — напиши «правка верна, причина ревьюера неверна» и почему.'
        : stage === 'Границы и признаки готовности'
          ? 'Правка сделана не целиком. Подскажи, где и что ещё поменять, или вставь нужный кусок.'
          : head?.where
            ? `Как исправить ошибку в ${head.where.split('/').pop()}? Вставь правильный кусок кода или опиши, что поменять — исполнитель сделает по твоей подсказке.`
            : 'Подскажи решение: кусок кода или пару слов, что сделать иначе.';
  return { stage, summary, errors, tried, need };
}
