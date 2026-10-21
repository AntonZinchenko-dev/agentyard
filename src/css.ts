// Разбор CSS без библиотек: правила, объявления, @media, подстановка var(--x).

export interface CssRule {
  selector: string;
  decls: Record<string, string>;
  media: string | null;
}

export function parseCss(css: string): CssRule[] {
  const out: CssRule[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const walk = (text: string, media: string | null) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      // ищем парную скобку
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith('@media')) walk(body, head);
      else if (!head.startsWith('@')) {
        const decls: Record<string, string> = {};
        for (const d of body.split(';')) {
          const k = d.indexOf(':');
          if (k > 0) decls[d.slice(0, k).trim().toLowerCase()] = d.slice(k + 1).trim().replace(/\s*!important$/, '');
        }
        for (const sel of head.split(',')) out.push({ selector: sel.trim(), decls, media });
      }
      i = j;
    }
  };
  walk(clean, null);
  return out;
}

/** Значение свойства для селектора (последнее правило побеждает), с подстановкой var(--x) из :root. */
export function cssValue(rules: CssRule[], selector: RegExp, props: string[], opts: { media?: boolean } = {}): string | null {
  const vars: Record<string, string> = {};
  for (const r of rules) if (!r.media && /^(:root|html|body)$/.test(r.selector)) for (const [k, v] of Object.entries(r.decls)) if (k.startsWith('--')) vars[k] = v;
  let value: string | null = null;
  for (const r of rules) {
    if (!!r.media !== !!opts.media || !selector.test(r.selector)) continue;
    for (const p of props) if (r.decls[p]) value = r.decls[p]!;
  }
  for (let k = 0; value && k < 5 && /var\(/.test(value); k++) value = value.replace(/var\((--[\w-]+)(?:,\s*([^)]+))?\)/g, (_m, n: string, fb?: string) => vars[n] ?? fb ?? '');
  return value;
}


const FAMILY: Record<string, string> = { background: 'background', 'background-color': 'background', border: 'border', 'border-color': 'border', color: 'color' };
const family = (p: string) => FAMILY[p] ?? p;

/** Селектор `big` — уточнение `base` (.af-btn → .af-btn.primary, .af-btn:hover, .af-table .af-btn). */
function refines(big: string, base: string): boolean {
  if (big === base) return false;
  const i = big.indexOf(base);
  if (i < 0) return false;
  const after = big[i + base.length];
  const before = i > 0 ? big[i - 1] : ' ';
  return (after === undefined || /[.:[\s>~+#]/.test(after)) && /[\s>~+]/.test(before ?? ' ');
}

/**
 * Что из правок CSS на экране НЕ проявится: изменённое свойство перебивает более точное правило того же файла.
 * Классический промах: покрасили .af-btn, а у .af-btn.primary свой фон — основные кнопки остались прежними.
 */
export function cssOverrideWarnings(before: string, after: string): string[] {
  const old = parseCss(before);
  const now = parseCss(after);
  const oldVal = (sel: string, prop: string, media: string | null) => {
    let v: string | undefined;
    for (const r of old) if (r.selector === sel && r.media === media && r.decls[prop] !== undefined) v = r.decls[prop];
    return v;
  };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of now) {
    if (r.media) continue;
    for (const [prop, value] of Object.entries(r.decls)) {
      if (prop.startsWith('--') || oldVal(r.selector, prop, null) === value) continue;
      for (const o of now) {
        if (o.media || !refines(o.selector, r.selector)) continue;
        const clash = Object.entries(o.decls).find(([p, v]) => family(p) === family(prop) && v !== value);
        if (!clash) continue;
        const key = `${r.selector}|${prop}|${o.selector}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(`Изменено \`${r.selector} { ${prop}: ${value} }\`, но у \`${o.selector}\` своё \`${clash[0]}: ${clash[1]}\` — для этих элементов изменение не видно.`);
      }
    }
  }
  return out.slice(0, 8);
}

const HUES: [RegExp, string, (h: number, s: number, l: number) => boolean][] = [
  [/красн|\bred\b/i, 'красный', (h, s, l) => (h <= 20 || h >= 340) && s >= 0.45 && l >= 0.2 && l <= 0.75],
  [/син|голуб|\bblue\b/i, 'синий', (h, s, l) => h >= 190 && h <= 250 && s >= 0.35 && l >= 0.15 && l <= 0.8],
  [/зел[её]н|\bgreen\b/i, 'зелёный', (h, s, l) => h >= 80 && h <= 160 && s >= 0.3 && l >= 0.15 && l <= 0.8],
  [/ж[её]лт|\byellow\b/i, 'жёлтый', (h, s, l) => h >= 45 && h <= 70 && s >= 0.5 && l >= 0.3],
  [/оранж|\borange\b/i, 'оранжевый', (h, s, l) => h > 20 && h < 45 && s >= 0.5 && l >= 0.3],
  [/фиолет|пурпур|\bpurple\b/i, 'фиолетовый', (h, s, l) => h >= 260 && h <= 300 && s >= 0.3],
  [/ч[её]рн|\bblack\b/i, 'чёрный', (_h, _s, l) => l <= 0.15],
  [/бел|\bwhite\b/i, 'белый', (_h, _s, l) => l >= 0.92],
];

const NAMED_CSS: Record<string, [number, number, number]> = {
  red: [255, 0, 0], crimson: [220, 20, 60], firebrick: [178, 34, 34], darkred: [139, 0, 0], tomato: [255, 99, 71], blue: [0, 0, 255], navy: [0, 0, 128],
  green: [0, 128, 0], white: [255, 255, 255], black: [0, 0, 0], orange: [255, 165, 0], yellow: [255, 255, 0], purple: [128, 0, 128], gray: [128, 128, 128], grey: [128, 128, 128],
};

export function colorOf(v: string | null): [number, number, number] | null {
  if (!v) return null;
  const s = v.toLowerCase();
  const hex = /#([0-9a-f]{3,8})\b/.exec(s);
  if (hex) {
    const h = hex[1]!;
    const full = h.length <= 4 ? h.slice(0, 3).split('').map((c) => c + c).join('') : h.slice(0, 6);
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  }
  const rgb = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(s);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  for (const [name, c] of Object.entries(NAMED_CSS)) if (new RegExp(`\\b${name}\\b`).test(s)) return c;
  return null;
}

function hsl([r, g, b]: [number, number, number]): [number, number, number] {
  const [x, y, z] = [r / 255, g / 255, b / 255];
  const max = Math.max(x, y, z);
  const min = Math.min(x, y, z);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === x ? ((y - z) / d) % 6 : max === y ? (z - x) / d + 2 : (x - y) / d + 4;
  h = (h * 60 + 360) % 360;
  return [h, s, l];
}

/**
 * Факты о цвете элементов, о которых просит цель («кнопки красными»): какой фон у каждого правила кнопок
 * и подходит ли он. Модель может решить, что «покрасили .danger — значит, кнопки красные»; цифры так не ошибутся.
 */
export function colorFacts(goal: string, css: string): string[] {
  const hue = HUES.find(([re]) => re.test(goal));
  if (!hue) return [];
  const element = /кноп|button|\bbtn\b/i.test(goal) ? /btn|button/i : /ссылк|link/i.test(goal) ? /(^|\s)a(\b|:)|link/i : /шапк|header|thead|th\b/i.test(goal) ? /th|thead|header/i : null;
  if (!element) return [];
  const rules = parseCss(css).filter((r) => !r.media && element.test(r.selector) && !/:(hover|focus|active|disabled)/.test(r.selector));
  const bySel = new Map<string, string>();
  for (const r of rules) {
    const v = r.decls['background-color'] ?? r.decls.background;
    if (v) bySel.set(r.selector, v);
  }
  const out: string[] = [];
  const ok: string[] = [];
  const not: string[] = [];
  for (const [sel, v] of bySel) {
    const c = colorOf(v);
    if (!c) continue;
    const [h, s, l] = hsl(c);
    (hue[2](h, s, l) ? ok : not).push(`${sel} (${v.trim()})`);
  }
  if (!ok.length && !not.length) return [];
  out.push(`Цвет фона по правилам CSS: ${hue[1]} — ${ok.length ? ok.join(', ') : 'ни одного'}; НЕ ${hue[1]} — ${not.length ? not.join(', ') : 'нет'}.`);
  return out;
}
