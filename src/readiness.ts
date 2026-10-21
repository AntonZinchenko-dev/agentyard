// Готовность проекта к прогону: проверка без модели, до планирования.
// Отвечает на вопрос «чем конвейер сможет проверить работу агентов в этом проекте».

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { detectCommands, hasLocalBin } from './repomap.ts';
import { detectStacks } from './stacks.ts';

export interface ReadinessItem {
  /** ok — всё хорошо; warn — прогон возможен, но проверка слабее; block — прогон не имеет смысла. */
  level: 'ok' | 'warn' | 'block';
  code: 'stack' | 'root' | 'not-root' | 'tests' | 'no-tests' | 'deps' | 'no-deps' | 'types' | 'no-types' | 'git' | 'no-git';
  text: string;
  /** Предлагаемая папка (для not-root). */
  suggest?: string;
}

const MARKERS = ['package.json', 'pyproject.toml', 'pytest.ini', 'requirements.txt', 'setup.py', 'manage.py', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile'];

/** Ближайшая папка выше, похожая на корень проекта. */
export function findProjectRootAbove(dir: string, maxUp = 5): string | null {
  let cur = path.resolve(dir);
  for (let i = 0; i < maxUp; i++) {
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
    if (MARKERS.some((m) => existsSync(path.join(cur, m)))) return cur;
  }
  return null;
}

export function checkReadiness(dir: string, isGitRepo: boolean): ReadinessItem[] {
  const abs = path.resolve(dir);
  const out: ReadinessItem[] = [];
  const stacks = existsSync(abs) ? detectStacks(abs) : [];
  // корень: свой манифест или подпроекты внутри (monorepo: backend/ + frontend/)
  const isRoot = MARKERS.some((m) => existsSync(path.join(abs, m))) || stacks.length > 0;
  if (!isRoot) {
    const above = findProjectRootAbove(abs);
    out.push(
      above
        ? { level: 'warn', code: 'not-root', text: `Это подпапка проекта, корень выше — ${above}. Для правок кода лучше выбрать корень: там работают проверки. Для документов и данных подойдёт и эта папка.`, suggest: above }
        : { level: 'ok', code: 'not-root', text: 'Папка без кода — подойдёт для задач с документами и данными: краткое содержание, разбор, извлечение в таблицу. Результат появится в папке out/.' },
    );
  } else out.push({ level: 'ok', code: 'root', text: 'Корень проекта.' });
  if (stacks.length) out.push({ level: 'ok', code: 'stack', text: `Стек: ${stacks.map((s) => `${s.name}${s.dir ? ` в ${s.dir}/` : ''}`).join('; ')}.` });

  const cmds = detectCommands(abs, stacks);
  const pkgPath = path.join(abs, 'package.json');
  let deps = 0;
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies?: object; devDependencies?: object };
      deps = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
    } catch {
      /* битый package.json */
    }
  }
  // без node_modules не работают проверки — предупреждаем, только если проверять есть чем (тесты или TypeScript)
  const needsDeps = !!cmds.test || existsSync(path.join(abs, 'tsconfig.json'));
  if (deps > 0 && needsDeps && !existsSync(path.join(abs, 'node_modules'))) {
    out.push({ level: 'warn', code: 'no-deps', text: `Зависимости не установлены (нет node_modules). Выполни в папке проекта: npm install — без этого не работают проверка типов и тесты.` });
  } else if (deps > 0 && existsSync(path.join(abs, 'node_modules'))) out.push({ level: 'ok', code: 'deps', text: 'Зависимости установлены.' });

  if (cmds.typecheck && !existsSync(path.join(abs, 'tsconfig.json'))) out.push({ level: 'ok', code: 'types', text: `Сборка и проверка кода: ${cmds.typecheck.split(' ;; ').join(', ')}.` });
  if (cmds.test) out.push({ level: 'ok', code: 'tests', text: `Тесты: ${cmds.test.split(' ;; ').join(', ')}.` });
  else if (isRoot && stacks.length)
    out.push({ level: 'warn', code: 'no-tests', text: 'В проекте нет тестов. Программа проверит синтаксис и типы, а работает ли страница и как выглядит — посмотрит ревью и ты.' });

  if (existsSync(path.join(abs, 'tsconfig.json'))) {
    if (cmds.typecheck) out.push({ level: 'ok', code: 'types', text: 'Проверка типов TypeScript доступна.' });
    else if (!hasLocalBin(abs, 'tsc')) out.push({ level: 'warn', code: 'no-types', text: 'Проверка типов недоступна: TypeScript не установлен в проекте (npm install).' });
  }

  out.push(isGitRepo ? { level: 'ok', code: 'git', text: 'Git-репозиторий найден.' } : { level: 'ok', code: 'no-git', text: 'Папка не под git — при запуске программа сама создаст репозиторий с исходным состоянием, чтобы любое изменение можно было откатить.' });
  return out;
}
