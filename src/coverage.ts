// Проверка полноты теста: каждое требование цели должно иметь конкретную проверку в тесте.
// Модель-ревьюер выписывает требования и цитирует строку теста; программа сверяет цитату с файлом
// и сама ищет в тесте значения из цели (коды, тексты ошибок). Модели можно ошибиться — цитату не подделаешь.

export interface CoverageItem {
  requirement: string;
  /** Строка из теста дословно; пусто — проверки нет. */
  check: string;
}

export interface CoverageVerdict {
  /** Цитаты, которых нет в тесте, — ревьюер должен их исправить. */
  badQuotes: string[];
  /** Требования без проверки. */
  uncovered: string[];
  /** Значения из цели, которых нет в тесте вообще. */
  missingLiterals: string[];
}

const squash = (s: string) => s.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();

/** Есть ли цитата в тексте теста (без учёта пробелов и финальной точки с запятой). */
export function quoteFound(quote: string, testText: string): boolean {
  const q = squash(quote);
  if (q.length < 4) return false;
  return squash(testText).includes(q);
}

/** Конкретные значения из цели: «тексты», "строки", КОДЫ_ВРОДЕ_SAVE10. Пути файлов и имена функций не берём. */
export function goalLiterals(goal: string): string[] {
  const out = new Set<string>();
  for (const m of goal.matchAll(/«([^»]{2,80})»|"([^"]{2,80})"/g)) {
    const v = (m[1] ?? m[2])!.trim();
    if (!/[\\/]|\.\w{1,4}$/.test(v)) out.add(v);
  }
  for (const m of goal.matchAll(/\b[A-Z][A-Z0-9_]*\d[A-Z0-9_]*\b|\b[A-Z]{3,}[A-Z0-9_]*\b/g)) {
    const v = m[0];
    if (!/^(API|JSON|HTTP|URL|SQL|CSV|UTF|ID|OK)$/.test(v)) out.add(v);
  }
  return [...out];
}

export function checkCoverage(items: CoverageItem[], testText: string, goal: string | undefined): CoverageVerdict {
  const badQuotes: string[] = [];
  const uncovered: string[] = [];
  for (const it of items) {
    const check = it.check.trim();
    if (!check) uncovered.push(it.requirement);
    else if (!quoteFound(check, testText)) badQuotes.push(check);
  }
  const missingLiterals = goal ? goalLiterals(goal).filter((l) => !testText.includes(l)) : [];
  return { badQuotes, uncovered, missingLiterals };
}
