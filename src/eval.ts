// «Пьяный тест»: небрежные просьбы на учебных проектах, результат оценивает программа, а не модель.
// Прогон: ay eval [--only id,id] [--mock]. Итог — «сдано X из N», отчёт в eval-runs/<время>/eval.md.
// Смысл: мерить, стал ли конвейер лучше, на реальных моделях пользователя, а не на ощущениях.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createDemoRepo, createFeatureRepo, createWebRepo, PROMO_TEST } from './demo.ts';
import { runCommand } from './checks.ts';
import type { PipelineResult } from './pipeline.ts';

export interface Grade {
  pass: boolean;
  why: string;
}

export interface Scenario {
  id: string;
  /** Как человек это написал — специально небрежно. */
  goal: string;
  /** Что на самом деле хотели — для отчёта. */
  intent: string;
  make: (dir: string) => void;
  grade: (dir: string) => Promise<Grade> | Grade;
}

import { parseCss, cssValue } from './css.ts';
export { parseCss, cssValue };

const NAMED: Record<string, [number, number, number]> = {
  red: [255, 0, 0], crimson: [220, 20, 60], firebrick: [178, 34, 34], darkred: [139, 0, 0], tomato: [255, 99, 71], indianred: [205, 92, 92], orangered: [255, 69, 0], maroon: [128, 0, 0],
  blue: [0, 0, 255], green: [0, 128, 0], white: [255, 255, 255], black: [0, 0, 0],
};

export function parseColor(v: string | null): [number, number, number] | null {
  if (!v) return null;
  const s = v.toLowerCase();
  const hex = /#([0-9a-f]{3,8})\b/.exec(s);
  if (hex) {
    const h = hex[1]!;
    const full = h.length === 3 || h.length === 4 ? h.slice(0, 3).split('').map((c) => c + c).join('') : h.slice(0, 6);
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  }
  const rgb = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(s);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const hsl = /hsla?\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(s);
  if (hsl) {
    const [h, sat, l] = [Number(hsl[1]) / 360, Number(hsl[2]) / 100, Number(hsl[3]) / 100];
    const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
    const p = 2 * l - q;
    const f = (t: number) => {
      t = (t + 1) % 1;
      return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    };
    return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
  }
  for (const [name, c] of Object.entries(NAMED)) if (new RegExp(`\\b${name}\\b`).test(s)) return c;
  return null;
}

/** Красный — по оттенку (±20° от красного), насыщенный и не слишком тёмный/светлый: оранжевый и розоватый не в счёт. */
export function isReddish(c: [number, number, number] | null): boolean {
  if (!c) return false;
  const [r, g, b] = c.map((x) => x / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return false;
  const sat = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return (h <= 20 || h >= 340) && sat >= 0.45 && l >= 0.2 && l <= 0.75;
}

const WEB_PAGES = ['address', 'user', 'order', 'product', 'payment', 'review'].map((e) => `src/pages/${e}-list/ui/${e[0]!.toUpperCase()}${e.slice(1)}ListPage.tsx`);
const read = (dir: string, f: string) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8') : '');

// ---------- сценарии ----------

export const SCENARIOS: Scenario[] = [
  {
    id: 'web-red-buttons',
    goal: 'сделай кнопки красными бля',
    intent: 'Основные кнопки (.af-btn.primary) красные на всех страницах — через общий CSS.',
    make: createWebRepo,
    grade: (dir) => {
      const rules = parseCss(read(dir, 'src/shared/ui/generated.css'));
      const bg = cssValue(rules, /^\.af-btn\.primary$/, ['background', 'background-color']);
      if (isReddish(parseColor(bg))) return { pass: true, why: `.af-btn.primary: ${bg}` };
      const any = cssValue(rules, /^\.af-btn$/, ['background', 'background-color']);
      return { pass: false, why: `фон основной кнопки: ${bg ?? 'не задан'}; у .af-btn: ${any ?? 'не задан'}` };
    },
  },
  {
    id: 'web-sticky-header',
    goal: 'чтоб шапка у таблиц не уезжала когда листаешь',
    intent: 'Заголовки таблиц закреплены при прокрутке: position: sticky у th/thead.',
    make: createWebRepo,
    grade: (dir) => {
      const rules = parseCss(read(dir, 'src/shared/ui/generated.css'));
      const pos = cssValue(rules, /(^|\s|\.af-table\s+)(th|thead)(\b|$)|af-table\s+th|af-table\s+thead/, ['position']);
      return pos === 'sticky' || pos === '-webkit-sticky' ? { pass: true, why: 'th/thead: position: sticky' } : { pass: false, why: `position у шапки таблицы: ${pos ?? 'не задан'}` };
    },
  },
  {
    id: 'web-dark-theme',
    goal: 'ночью глаза режет, сделай тёмную тему',
    intent: 'В общем CSS есть @media (prefers-color-scheme: dark), где фон страницы тёмный, а текст светлый.',
    make: createWebRepo,
    grade: (dir) => {
      const rules = parseCss(read(dir, 'src/shared/ui/generated.css'));
      const pick = (props: string[]) =>
        cssValue(rules, /^(:root|html|body|\.af-page)$/, props, { media: true }) ??
        // переменные в тёмной теме: --bg / --text и т.п.
        cssValue(rules, /^(:root|html|body)$/, props.map((p) => `--${p.replace('background-color', 'bg').replace('background', 'bg')}`), { media: true });
      const bg = parseColor(pick(['background', 'background-color']));
      const fg = parseColor(pick(['color']) ?? cssValue(rules, /^(:root|html|body)$/, ['--text', '--fg', '--color'], { media: true }));
      const lum = (c: [number, number, number] | null) => (c ? (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 : null);
      const [lb, lf] = [lum(bg), lum(fg)];
      if (lb === null) return { pass: false, why: 'нет тёмного фона в @media (prefers-color-scheme: dark)' };
      if (lb > 0.35) return { pass: false, why: `фон в тёмной теме слишком светлый (${pick(['background', 'background-color'])})` };
      if (lf !== null && lf < 0.6) return { pass: false, why: 'текст в тёмной теме тёмный — не читается' };
      return { pass: true, why: 'тёмный фон в @media (prefers-color-scheme: dark)' };
    },
  },
  {
    id: 'web-title',
    goal: 'на странице адресов заголовок пусть будет Адреса доставки',
    intent: 'Заголовок h1 на странице адресов — «Адреса доставки», другие страницы не тронуты.',
    make: createWebRepo,
    grade: (dir) => {
      const page = read(dir, 'src/pages/address-list/ui/AddressListPage.tsx');
      const other = read(dir, 'src/pages/user-list/ui/UserListPage.tsx');
      if (!/<h1>\s*Адреса доставки\s*<\/h1>/.test(page)) return { pass: false, why: `h1 на странице адресов: ${/<h1>([^<]*)<\/h1>/.exec(page)?.[1] ?? 'нет'}` };
      if (!/<h1>Пользователи<\/h1>/.test(other)) return { pass: false, why: 'заодно испорчена страница пользователей' };
      return { pass: true, why: 'h1 = «Адреса доставки»' };
    },
  },
  {
    id: 'web-rename-everywhere',
    goal: 'везде где кнопка Добавить пусть будет Создать',
    intent: 'На всех страницах списков надпись кнопки «Создать» вместо «Добавить» — правка по образцу во всех однотипных файлах.',
    make: createWebRepo,
    grade: (dir) => {
      const pages = WEB_PAGES.map((f) => [f, read(dir, f)] as const);
      const bad = pages.filter(([, t]) => /Добавить/.test(t) || !/Создать/.test(t)).map(([f]) => f.split('/')[2]);
      return bad.length ? { pass: false, why: `не переименовано: ${bad.join(', ')}` } : { pass: true, why: `все ${pages.length} страниц` };
    },
  },
  {
    id: 'web-docker-port',
    goal: 'в докере порт 8080 надо а не 3000',
    intent: 'Dockerfile: PORT=8080 и EXPOSE 8080.',
    make: createWebRepo,
    grade: (dir) => {
      const d = read(dir, 'Dockerfile');
      const ok = /EXPOSE\s+8080/.test(d) && /PORT[=\s]+8080/.test(d) && !/\b3000\b/.test(d);
      return ok ? { pass: true, why: 'EXPOSE 8080, PORT=8080' } : { pass: false, why: `Dockerfile:\n${d}` };
    },
  },
  {
    id: 'web-ui-kit',
    goal: 'натяни какую нибудь популярную юай библиотеку чтоб выглядело норм',
    intent: 'Популярный UI-кит поставлен (в package.json), подключён в общем месте и используется на страницах вместо голых кнопок.',
    make: createWebRepo,
    grade: (dir) => {
      const pkg = JSON.parse(read(dir, 'package.json') || '{}') as { dependencies?: Record<string, string> };
      const kits = ['@mantine/core', 'antd', '@mui/material', '@chakra-ui/react', 'react-bootstrap', '@radix-ui/themes', 'primereact', '@nextui-org/react', '@heroui/react', 'flowbite-react', '@fluentui/react-components', '@blueprintjs/core'];
      const kit = kits.find((k) => pkg.dependencies?.[k]);
      if (!kit) return { pass: false, why: `в dependencies нет UI-кита: ${Object.keys(pkg.dependencies ?? {}).join(', ') || 'пусто'}` };
      const pages = WEB_PAGES.map((f) => read(dir, f));
      const using = pages.filter((t) => t.includes(`from '${kit}'`) || t.includes(`from "${kit}"`)).length;
      if (using < pages.length / 2) return { pass: false, why: `${kit} поставлен, но используется на ${using} из ${pages.length} страниц` };
      return { pass: true, why: `${kit} на ${using} из ${pages.length} страниц` };
    },
  },
  {
    id: 'shop-promo',
    goal: 'добавь промокоды: SAVE10 минус 10 проц, FIX500 минус 500 но не в минус, левый код ошибка "Неизвестный промокод". функция applyPromo в src/promo.js, тесты тоже напиши',
    intent: 'src/promo.js с applyPromo, проходящий скрытые тесты.',
    make: createFeatureRepo,
    grade: async (dir) => {
      if (!existsSync(path.join(dir, 'src/promo.js'))) return { pass: false, why: 'нет src/promo.js' };
      const hidden = path.join(dir, '.agentyard', 'eval-hidden.test.js');
      mkdirSync(path.dirname(hidden), { recursive: true });
      // тот же путь импорта ../src/promo.js: файл лежит в .agentyard/, на уровень ниже корня — как test/
      writeFileSync(hidden, PROMO_TEST);
      const r = await runCommand(`node --test "${hidden}"`, dir, 60_000);
      return r.code === 0 ? { pass: true, why: 'скрытые тесты прошли' } : { pass: false, why: r.output.split('\n').filter((l) => /not ok|Error|expected|actual/.test(l)).slice(0, 6).join('\n') };
    },
  },
  {
    id: 'demo-fix',
    goal: 'тесты падают почини',
    intent: 'Все тесты учебного проекта зелёные, тесты не тронуты.',
    make: createDemoRepo,
    grade: async (dir) => {
      const r = await runCommand('node --test', dir, 60_000);
      return r.code === 0 ? { pass: true, why: 'node --test зелёный' } : { pass: false, why: r.output.split('\n').filter((l) => /not ok/.test(l)).slice(0, 6).join('\n') };
    },
  },
];

export interface EvalRow {
  id: string;
  goal: string;
  intent: string;
  pass: boolean;
  why: string;
  seconds: number;
  done: number;
  human: number;
  runDir?: string;
  error?: string;
}

export function renderEval(rows: EvalRow[], meta: { models: string; started: string }): string {
  const passed = rows.filter((r) => r.pass).length;
  const lines = [
    `# Пьяный тест AgentYard — сдано ${passed} из ${rows.length}`,
    '',
    `Запуск: ${meta.started}. Модели: ${meta.models}.`,
    '',
    'Каждая просьба написана небрежно, как пишут на бегу. Результат проверяет программа по файлам проекта после прогона (с применением в проект), а не модель.',
    '',
    '| Сценарий | Просьба | Итог | Почему | Время |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.id} | ${r.goal.replace(/\|/g, '/')} | ${r.pass ? 'сдано' : 'НЕ сдано'} | ${(r.error ?? r.why).replace(/\n/g, ' ').replace(/\|/g, '/').slice(0, 300)} | ${Math.round(r.seconds)} с |`),
    '',
    '## Что хотели',
    '',
    ...rows.map((r) => `- **${r.id}**: ${r.intent}`),
    '',
  ];
  return lines.join('\n');
}

export type RunOne = (repo: string, goal: string) => Promise<PipelineResult>;

/** Прогнать сценарии по очереди. runOne — запуск конвейера (настоящие модели или учебные). */
export async function runEval(
  root: string,
  runOne: RunOne,
  only?: string[],
  log: (s: string) => void = () => undefined,
  onRow: (row: EvalRow) => void = () => undefined,
): Promise<EvalRow[]> {
  mkdirSync(root, { recursive: true });
  const rows: EvalRow[] = [];
  for (const sc of SCENARIOS.filter((s) => !only?.length || only.includes(s.id))) {
    const dir = path.join(root, sc.id);
    const started = Date.now();
    log(`▶ ${sc.id}: «${sc.goal}»`);
    try {
      sc.make(dir);
      const res = await runOne(dir, sc.goal);
      const g = await sc.grade(dir);
      rows.push({ id: sc.id, goal: sc.goal, intent: sc.intent, pass: g.pass, why: g.why, seconds: (Date.now() - started) / 1000, done: res.done.length, human: res.human.length, runDir: res.runDir });
    } catch (e) {
      rows.push({ id: sc.id, goal: sc.goal, intent: sc.intent, pass: false, why: '', error: (e as Error).message.slice(0, 400), seconds: (Date.now() - started) / 1000, done: 0, human: 0 });
    }
    const last = rows.at(-1)!;
    onRow(last);
    log(`  ${last.pass ? '✓ сдано' : '✗ НЕ сдано'} за ${Math.round(last.seconds)} с — ${(last.error ?? last.why).split('\n')[0]}`);
  }
  return rows;
}

// ---------- история экзаменов: видно, растёт ли балл от доработки к доработке ----------

export interface EvalHistoryEntry {
  at: string;
  models: string;
  passed: number;
  total: number;
  dir: string;
  rows: { id: string; pass: boolean; seconds: number }[];
}

export function readHistory(root: string): EvalHistoryEntry[] {
  const f = path.join(root, 'history.json');
  try {
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as EvalHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export function appendHistory(root: string, entry: EvalHistoryEntry): EvalHistoryEntry[] {
  mkdirSync(root, { recursive: true });
  const all = [...readHistory(root), entry].slice(-100);
  writeFileSync(path.join(root, 'history.json'), JSON.stringify(all, null, 2));
  return all;
}

/** Сравнение с прошлым экзаменом простыми словами. */
export function trendText(history: EvalHistoryEntry[]): string {
  const last = history.at(-1);
  const prev = history.length > 1 ? history.at(-2) : undefined;
  if (!last) return '';
  if (!prev) return `Первый экзамен: ${last.passed} из ${last.total}.`;
  const d = last.passed - prev.passed;
  const fixed = last.rows.filter((r) => r.pass && prev.rows.find((p) => p.id === r.id && !p.pass)).map((r) => r.id);
  const broke = last.rows.filter((r) => !r.pass && prev.rows.find((p) => p.id === r.id && p.pass)).map((r) => r.id);
  return [
    `${last.passed} из ${last.total} (было ${prev.passed} из ${prev.total}${d > 0 ? `, +${d}` : d < 0 ? `, ${d}` : ', без изменений'}).`,
    fixed.length ? `Стали сдаваться: ${fixed.join(', ')}.` : '',
    broke.length ? `Перестали сдаваться: ${broke.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
