// Где в коде то, о чём просят. Поиск без модели: слова цели → термины кода → строки файлов.
// Небрежная цель («кнопки красными сделай бля») превращается в адрес: src/shared/ui/generated.css, .af-btn.
// Маленькой модели гораздо проще поправить найденное место, чем самой искать его по 300 файлам.

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Слова интерфейса и разговорные слова → то, как это называется в коде. Ключ — начало слова. */
const SYNONYMS: Record<string, string[]> = {
  кноп: ['btn', 'button'],
  // только «как назвать цвет», без danger и готовых красных кодов: иначе поиск ведёт к уже красной .danger,
  // и модель красит её, а не то, что просили (прогон 20.10 02:38)
  красн: ['red', 'color', 'background'],
  син: ['blue', 'primary', 'color'],
  зелен: ['green', 'success', 'color'],
  желт: ['yellow', 'warning', 'color'],
  черн: ['black', '#000', 'color'],
  бел: ['white', '#fff', 'color'],
  сер: ['gray', 'grey', 'muted', 'color'],
  цвет: ['color', 'background'],
  фон: ['background', 'bg'],
  шрифт: ['font'],
  размер: ['size', 'font-size', 'width', 'height'],
  жирн: ['bold', 'font-weight'],
  отступ: ['padding', 'margin', 'gap'],
  скругл: ['radius', 'border-radius'],
  рамк: ['border'],
  тен: ['shadow'],
  тёмн: ['dark', 'prefers-color-scheme'],
  темн: ['dark', 'prefers-color-scheme'],
  тем: ['theme', 'dark'],
  шапк: ['header', 'thead', 'head'],
  подвал: ['footer'],
  таблиц: ['table', 'tr', 'td', 'th'],
  строк: ['row', 'tr', 'line'],
  колонк: ['column', 'col', 'th'],
  форм: ['form'],
  пол: ['input', 'field'],
  ввод: ['input'],
  выпада: ['select', 'dropdown'],
  галочк: ['checkbox'],
  заголов: ['title', 'h1', 'heading', 'head'],
  ссылк: ['link', 'href'],
  меню: ['nav', 'menu'],
  навигац: ['nav'],
  страниц: ['page'],
  список: ['list'],
  карточк: ['card'],
  ошибк: ['error', 'alert'],
  предупрежд: ['alert', 'warning'],
  иконк: ['icon'],
  картинк: ['img', 'image'],
  логотип: ['logo'],
  модальн: ['modal', 'dialog'],
  окн: ['modal', 'dialog', 'window'],
  фильтр: ['filter'],
  поиск: ['search'],
  сортир: ['sort'],
  пагинац: ['pager', 'pagination'],
  листа: ['pager', 'pagination', 'sticky', 'scroll'],
  уезжа: ['sticky', 'position', 'fixed'],
  скрол: ['sticky', 'scroll', 'overflow'],
  прокрут: ['sticky', 'scroll', 'overflow'],
  прилип: ['sticky', 'position'],
  фиксир: ['sticky', 'fixed', 'position'],
  дат: ['date'],
  цен: ['price'],
  скидк: ['discount', 'promo'],
  промокод: ['promo'],
  корзин: ['cart'],
  доставк: ['delivery'],
  заказ: ['order'],
  пользовател: ['user'],
  логин: ['login', 'auth'],
  вход: ['login', 'auth', 'signin'],
  парол: ['password'],
  апи: ['api'],
  запрос: ['fetch', 'request', 'api'],
  тест: ['test'],
  докер: ['dockerfile', 'docker'],
  стил: ['css', 'style', 'class'],
  липк: ['sticky', 'position'],
  закреп: ['sticky', 'fixed', 'position'],
  ширин: ['width'],
  высот: ['height'],
  выравн: ['align', 'justify'],
  центр: ['center', 'align'],
  скры: ['hidden', 'display'],
  порт: ['port', 'expose'],
  // английские и полуанглийские просьбы: «make buttons red», «хедер», «футер»
  button: ['btn', 'button'],
  btn: ['btn', 'button'],
  colo: ['color', 'background'],
  red: ['red', 'color', 'background'],
  blue: ['blue', 'primary', 'color'],
  green: ['green', 'success', 'color'],
  header: ['header', 'thead', 'head'],
  хедер: ['header', 'thead', 'head'],
  footer: ['footer'],
  футер: ['footer'],
  sticky: ['sticky', 'position'],
  table: ['table', 'tr', 'td', 'th'],
  title: ['title', 'h1', 'heading'],
  font: ['font'],
  dark: ['dark', 'prefers-color-scheme'],
  port: ['port', 'expose'],
  docker: ['dockerfile', 'docker'],
  nav: ['nav', 'menu'],
  menu: ['nav', 'menu'],
};

/** Слова, которые ничего не говорят о месте в коде (в том числе ругательства — «пьяный» запрос). */
const NOISE = new Set(
  'и в во на не но а да нет ну вот это этот эта эти тот та то так как что чтоб чтобы чтобы-то все всё вся весь тут там здесь сделай сделать сделайте надо нужно пусть давай плиз пж пожалуйста короче типа просто ещё еще уже очень нормально норм хорошо красиво бля блять блядь нахуй хуй хуя пиздец ебать ебаный ебаная сука нах чё че чо мне мой моя наш наша поменяй поменять измени изменить сменить смени исправь исправить почини починить добавь добавить убери убрать был была было были будет можно файл файлы файле код коде проект проекте the a an and or to of in on for with make please'.split(
    ' ',
  ),
);

const TEXT_EXT = /\.(m?[jt]sx?|css|scss|sass|less|html?|vue|svelte|json|md|py|go|rs|java|kt|cs|php|rb|yml|yaml|toml|sql|sh|ps1|dockerfile)$|(^|\/)Dockerfile$/i;
const VISUAL = /цвет|красн|син|зелен|желт|черн|бел|сер|фон|шрифт|отступ|скругл|рамк|тен|тёмн|темн|стил|размер|жирн|выгляд|красив|дизайн|липк|закреп|уезжа|прилип|скрол|прокрут|фиксир|ширин|высот|выравн|центр|color|colour|style|css|red|blue|green|font|sticky|dark|look/i;

function stem(w: string): string {
  const x = w.toLowerCase().replace(/ё/g, 'е');
  if (x.length <= 4 || !/[а-я]/.test(x)) return x;
  return x.replace(/(ами|ями|ого|ему|ому|ыми|ими|ая|яя|ое|ее|ые|ие|ый|ий|ой|ом|ем|ам|ям|ах|ях|ую|юю|ов|ев|ей|ы|и|а|я|о|е|у|ю|ь)$/, '');
}

export interface GoalTerms {
  /** Термины кода, которые искать. */
  terms: string[];
  /** Буквальные строки из цели (тексты в кавычках, идентификаторы, имена файлов). */
  literals: string[];
  /** Основы русских слов без перевода — тексты на экране и названия сущностей («адрес» найдёт «Адреса»). */
  words: string[];
  visual: boolean;
}

export function goalTerms(goal: string): GoalTerms {
  const literals = new Set<string>();
  for (const m of goal.matchAll(/[«"'`]([^»"'`]{2,60})[»"'`]/g)) literals.add(m[1]!.trim());
  for (const m of goal.matchAll(/[\w./-]*[A-Za-z_][\w-]*\.[a-z]{1,5}\b|\b[a-z]+[A-Z]\w*\b|\b[a-z]+(?:[-_][a-z0-9]+)+\b|#[0-9a-fA-F]{3,8}\b/g)) literals.add(m[0]);
  // слова с заглавной буквы в середине фразы часто — текст на экране («кнопка Добавить»)
  for (const m of goal.matchAll(/(?<=[^.!?]\s)([А-ЯЁ][а-яё]{3,})/g)) literals.add(m[1]!);

  const terms = new Set<string>();
  const words = new Set<string>();
  const tokens = goal.toLowerCase().split(/[^a-zа-яё0-9#_-]+/i).filter(Boolean);
  for (const [i, raw] of tokens.entries()) {
    // «кнопку добавить», «кнопка сохранить» — слово после «кнопка» скорее надпись на ней, а не глагол
    if (i > 0 && stem(tokens[i - 1]!).startsWith('кноп') && /^[а-яё]{4,}$/.test(raw) && !/^(сделай|сделать|красн|син|зелен|больш|меньш)/.test(raw)) {
      literals.add(raw[0]!.toUpperCase() + raw.slice(1));
      continue;
    }
    if (NOISE.has(raw)) continue;
    const s = stem(raw);
    let mapped = false;
    for (const [key, values] of Object.entries(SYNONYMS)) {
      if (s.startsWith(key) || raw.startsWith(key)) {
        values.forEach((v) => terms.add(v));
        mapped = true;
      }
    }
    if (!mapped && /^[a-z][a-z0-9_-]{2,}$/.test(raw)) terms.add(raw);
    else if (!mapped && /^[а-яё]{4,}$/.test(raw) && s.length >= 4) words.add(s.slice(0, Math.max(4, s.length)));
  }
  return { terms: [...terms], literals: [...literals], words: [...words], visual: VISUAL.test(goal) };
}

export interface FileHit {
  file: string;
  score: number;
  lines: { n: number; text: string }[];
}

/** Файлы, где встречаются термины цели: больше разных терминов — выше; стили выше для «визуальных» целей. */
export function searchRepo(root: string, files: string[], q: GoalTerms, maxFiles = 6): FileHit[] {
  const needles = [
    ...q.terms.map((t) => ({ t: t.toLowerCase(), w: 1 })),
    ...q.words.map((t) => ({ t, w: 1.5 })),
    ...q.literals.map((t) => ({ t: t.toLowerCase(), w: 3 })),
  ].filter((x) => x.t.length >= 2);
  if (needles.length === 0) return [];
  const hits: FileHit[] = [];
  // какие файлы стилей подключаются чаще всего — это «главный» CSS проекта
  const cssFiles = files.filter((f) => /\.(css|scss|sass|less)$/i.test(f));
  const cssUse = new Map<string, number>(cssFiles.map((f) => [f, 0]));
  for (const f of files) {
    if (!TEXT_EXT.test(f) || /(^|\/)(package-lock\.json|pnpm-lock|yarn\.lock)/.test(f)) continue;
    const abs = path.join(root, f);
    let text: string;
    try {
      if (statSync(abs).size > 200_000) continue;
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const c of cssFiles) if (c !== f && text.includes(path.basename(c))) cssUse.set(c, (cssUse.get(c) ?? 0) + 1);
    const lower = text.toLowerCase();
    const pathLower = f.toLowerCase();
    let score = 0;
    const matched = new Set<string>();
    for (const n of needles) {
      // короткие термины («tr», «th», «red», «head», «page») — только целым словом, иначе совпадёт с «string», «headers»
      const short = n.t.length <= 4 && /^[a-z#]/.test(n.t);
      const re = new RegExp(short ? `(^|[^a-z0-9])${escapeRe(n.t)}([^a-z0-9]|$)` : escapeRe(n.t), 'g');
      // совпадение в имени файла весит как несколько в тексте: «докер» → Dockerfile
      const count = (lower.match(re) ?? []).length + (pathLower.includes(n.t) ? 6 : 0);
      if (count > 0) {
        matched.add(n.t);
        score += n.w * (1 + Math.log2(1 + count));
      }
    }
    if (matched.size === 0) continue;
    score *= 1 + (matched.size - 1) * 0.6; // несколько разных терминов в одном файле — сильный сигнал
    // «как выглядит» меняют стили: общий CSS важнее разметки, где те же классы повторяются на каждой странице
    if (q.visual && /\.(css|scss|sass|less)$/i.test(f)) score *= 4;
    // строки с совпадениями (первые несколько)
    const lines: { n: number; text: string }[] = [];
    const all = text.split(/\r?\n/);
    for (let i = 0; i < all.length && lines.length < 6; i++) {
      const l = all[i]!.toLowerCase();
      if ([...matched].some((m) => l.includes(m))) lines.push({ n: i + 1, text: all[i]!.trim().slice(0, 160) });
    }
    hits.push({ file: f, score, lines });
  }
  hits.sort((a, b) => b.score - a.score);
  // просьба про внешний вид, а в стилях совпадений нет (тёмной темы ещё нет — искать нечего): предлагаем главный CSS
  if (q.visual && !hits.some((h) => /\.(css|scss|sass|less)$/i.test(h.file))) {
    const main = [...cssUse].sort((a, b) => b[1] - a[1])[0];
    if (main) {
      const lines = readFileSync(path.join(root, main[0]), 'utf8').split(/\r?\n/).slice(0, 4).map((t, i) => ({ n: i + 1, text: t.trim().slice(0, 160) }));
      hits.unshift({ file: main[0], score: Infinity, lines: [{ n: 0, text: `(главный файл стилей: подключён в ${main[1]} файлах)` }, ...lines] });
    }
  }
  // файлы-«близнецы» (16 одинаковых страниц) не должны вытеснить остальное: не больше двух на шаблон каталога
  const out: FileHit[] = [];
  const perShape = new Map<string, number>();
  for (const h of hits) {
    const parts = h.file.split('/');
    const shape = parts.length > 3 ? [...parts.slice(0, 2), '*', ...parts.slice(3, -1), path.extname(h.file)].join('/') : h.file;
    const n = perShape.get(shape) ?? 0;
    if (n >= 2) continue;
    perShape.set(shape, n + 1);
    out.push(h);
    if (out.length >= maxFiles) break;
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Раздел запроса для планировщика. */
export function renderHits(hits: FileHit[], q: GoalTerms): string {
  if (hits.length === 0) return '';
  const head = `Искал по словам цели: ${[...q.literals, ...q.words, ...q.terms].slice(0, 18).join(', ')}.`;
  const body = hits.map((h) => [`- ${h.file}`, ...h.lines.map((l) => `    ${l.n}: ${l.text}`)].join('\n')).join('\n');
  return `${head}\n${body}`;
}
