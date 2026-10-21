// Стек проекта без модели: какие языки и сборщики, где корни подпроектов (monorepo: backend/ на Go, frontend/ на Next),
// какими командами проверять сборку, типы и тесты. От этого зависит главное в самостоятельности:
// агент исправляет себя только там, где программа может проверить его работу.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export type StackId = 'node' | 'python' | 'go' | 'rust' | 'maven' | 'gradle' | 'dotnet' | 'php' | 'ruby';

export interface Stack {
  id: StackId;
  /** Папка подпроекта от корня ('' — сам корень). */
  dir: string;
  /** Как назвать человеку: «Go», «Python (FastAPI)», «Node (Next.js)». */
  name: string;
  test: string | null;
  /** Запуск отдельных тестовых файлов: {files} — список (только где раннер это умеет). */
  testFiles: string | null;
  lint: string | null;
  /** Сборка или проверка типов — ловит большинство ошибок компилируемых языков. */
  typecheck: string | null;
  /** Фреймворки и библиотеки — по ним подбираются рецепты. */
  tags: string[];
}

/** Разделитель частей составной команды: runCommand выполнит их по очереди и упадёт, если упала любая. */
export const MULTI = ' ;; ';

const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.agentyard', '.next', 'coverage', '__pycache__', '.venv', 'venv', 'target', 'bin', 'obj', 'vendor', '.gradle', '.idea', '.vscode', 'out']);
const win = process.platform === 'win32';

const read = (f: string) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};

function hasFile(dir: string, re: RegExp, depth = 3): boolean {
  if (depth < 0 || !existsSync(dir)) return false;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  for (const n of names) {
    if (SKIP.has(n)) continue;
    const abs = path.join(dir, n);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (hasFile(abs, re, depth - 1)) return true;
    } else if (re.test(n)) return true;
  }
  return false;
}

/** Где-то есть локальная утилита из node_modules/.bin (на Windows — .cmd). */
function localBin(dir: string, name: string): boolean {
  const bin = path.join(dir, 'node_modules', '.bin', name);
  return existsSync(bin) || existsSync(`${bin}.cmd`);
}

function nodeStack(dir: string): Stack | null {
  const pkgPath = path.join(dir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(read(pkgPath));
  } catch {
    /* битый package.json */
  }
  const s = pkg.scripts ?? {};
  const testScript = s.test ?? '';
  let testFiles: string | null = null;
  if (/node\s+--test/.test(testScript)) testFiles = 'node --test {files}';
  else if (/vitest/.test(testScript)) testFiles = 'npx --no-install vitest run {files}';
  else if (/jest/.test(testScript)) testFiles = 'npx --no-install jest {files}';
  else if (/mocha/.test(testScript)) testFiles = 'npx --no-install mocha {files}';
  const deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  const fw = [
    ['next', 'Next.js'],
    ['nuxt', 'Nuxt'],
    ['@angular/core', 'Angular'],
    ['vue', 'Vue'],
    ['svelte', 'Svelte'],
    ['react', 'React'],
    ['@nestjs/core', 'NestJS'],
    ['express', 'Express'],
    ['fastify', 'Fastify'],
  ].find(([d]) => deps.includes(d!));
  return {
    id: 'node',
    dir: '',
    name: `Node${fw ? ` (${fw[1]})` : ''}${existsSync(path.join(dir, 'tsconfig.json')) ? ', TypeScript' : ''}`,
    test: s.test && !/no test specified/.test(s.test) ? 'npm test' : null,
    testFiles,
    lint: s.lint ? 'npm run lint' : null,
    // npx без установленного typescript скачивает чужой пакет «tsc» — поэтому только локальный и только --no-install
    typecheck: s.typecheck ? 'npm run typecheck' : existsSync(path.join(dir, 'tsconfig.json')) && localBin(dir, 'tsc') ? 'npx --no-install tsc --noEmit' : null,
    tags: ['node', ...deps],
  };
}

function pythonStack(dir: string): Stack | null {
  const markers = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'pytest.ini', 'manage.py', 'Pipfile'];
  if (!markers.some((m) => existsSync(path.join(dir, m)))) return null;
  const text = markers.map((m) => read(path.join(dir, m))).join('\n').toLowerCase();
  const tags = ['python', ...['django', 'fastapi', 'flask', 'sqlalchemy', 'pydantic', 'celery', 'pytest', 'alembic', 'aiogram', 'pandas'].filter((t) => text.includes(t))];
  const hasTests = existsSync(path.join(dir, 'pytest.ini')) || existsSync(path.join(dir, 'tests')) || /\[tool\.pytest/.test(text) || hasFile(dir, /^test_.+\.py$|_test\.py$/, 3);
  const mypy = existsSync(path.join(dir, 'mypy.ini')) || /\[tool\.mypy\]|\[mypy\]/.test(text);
  const ruff = existsSync(path.join(dir, 'ruff.toml')) || /\[tool\.ruff/.test(text);
  const django = existsSync(path.join(dir, 'manage.py'));
  const fw = tags.find((t) => ['django', 'fastapi', 'flask'].includes(t));
  return {
    id: 'python',
    dir: '',
    name: `Python${fw ? ` (${fw === 'fastapi' ? 'FastAPI' : fw === 'django' ? 'Django' : 'Flask'})` : ''}`,
    test: hasTests ? (django && !/pytest/.test(text) ? 'python manage.py test' : 'python -m pytest -q') : null,
    testFiles: hasTests && !(django && !/pytest/.test(text)) ? 'python -m pytest -q {files}' : null,
    lint: ruff ? 'python -m ruff check .' : null,
    typecheck: mypy ? 'python -m mypy .' : django ? 'python manage.py check' : null,
    tags,
  };
}

function goStack(dir: string): Stack | null {
  const mod = path.join(dir, 'go.mod');
  if (!existsSync(mod)) return null;
  const text = read(mod);
  const tags = ['go', ...['gin-gonic/gin', 'labstack/echo', 'gofiber/fiber', 'gorm.io/gorm', 'go-chi/chi', 'jackc/pgx', 'grpc'].filter((t) => text.includes(t)).map((t) => t.split('/').pop()!)];
  return { id: 'go', dir: '', name: 'Go', test: hasFile(dir, /_test\.go$/, 6) ? 'go test ./...' : null, testFiles: null, lint: null, typecheck: 'go vet ./...', tags };
}

function rustStack(dir: string): Stack | null {
  const cargo = path.join(dir, 'Cargo.toml');
  if (!existsSync(cargo)) return null;
  const text = read(cargo);
  const tags = ['rust', ...['tokio', 'axum', 'actix-web', 'serde', 'sqlx', 'diesel', 'clap'].filter((t) => text.includes(t))];
  return { id: 'rust', dir: '', name: 'Rust', test: 'cargo test --quiet', testFiles: null, lint: null, typecheck: 'cargo check --quiet --all-targets', tags };
}

function jvmStack(dir: string): Stack | null {
  const pom = path.join(dir, 'pom.xml');
  const gradle = ['build.gradle', 'build.gradle.kts'].map((f) => path.join(dir, f)).find((f) => existsSync(f));
  if (!existsSync(pom) && !gradle) return null;
  const text = read(pom) + read(gradle ?? '');
  const kotlin = /kotlin/i.test(text) || hasFile(path.join(dir, 'src'), /\.kt$/, 6);
  const tags = [kotlin ? 'kotlin' : 'java', ...['spring-boot', 'spring', 'hibernate', 'junit', 'ktor', 'lombok', 'android'].filter((t) => text.includes(t))];
  const hasTests = existsSync(path.join(dir, 'src', 'test'));
  if (existsSync(pom)) {
    const mvn = existsSync(path.join(dir, 'mvnw')) ? (win ? 'mvnw.cmd' : './mvnw') : 'mvn';
    return { id: 'maven', dir: '', name: `${kotlin ? 'Kotlin' : 'Java'} (Maven${tags.includes('spring-boot') ? ', Spring Boot' : ''})`, test: hasTests ? `${mvn} -q test` : null, testFiles: null, lint: null, typecheck: `${mvn} -q compile`, tags };
  }
  const g = existsSync(path.join(dir, 'gradlew')) ? (win ? 'gradlew.bat' : './gradlew') : 'gradle';
  return { id: 'gradle', dir: '', name: `${kotlin ? 'Kotlin' : 'Java'} (Gradle${tags.includes('spring-boot') ? ', Spring Boot' : ''})`, test: hasTests ? `${g} -q test` : null, testFiles: null, lint: null, typecheck: `${g} -q classes testClasses`, tags };
}

function dotnetStack(dir: string): Stack | null {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const sln = names.find((n) => n.endsWith('.sln'));
  const proj = names.find((n) => /\.(cs|fs|vb)proj$/.test(n));
  if (!sln && !proj) return null;
  const text = proj ? read(path.join(dir, proj)) : read(path.join(dir, sln!));
  const tags = ['dotnet', 'csharp', ...(/Microsoft\.NET\.Sdk\.Web|AspNetCore/i.test(text) ? ['aspnetcore'] : []), ...(/EntityFramework/i.test(text) ? ['efcore'] : [])];
  const hasTests = hasFile(dir, /Tests?\.csproj$/, 3);
  return { id: 'dotnet', dir: '', name: `.NET${tags.includes('aspnetcore') ? ' (ASP.NET Core)' : ''}`, test: hasTests ? 'dotnet test --nologo -v q' : null, testFiles: null, lint: null, typecheck: 'dotnet build --nologo -v q', tags };
}

function phpStack(dir: string): Stack | null {
  const composer = path.join(dir, 'composer.json');
  if (!existsSync(composer)) return null;
  const text = read(composer);
  const tags = ['php', ...['laravel/framework', 'symfony/', 'phpunit', 'doctrine', 'slim/slim'].filter((t) => text.includes(t)).map((t) => t.split('/')[0]!)];
  const phpunit = existsSync(path.join(dir, 'phpunit.xml')) || existsSync(path.join(dir, 'phpunit.xml.dist'));
  const phpstan = existsSync(path.join(dir, 'phpstan.neon')) || existsSync(path.join(dir, 'phpstan.neon.dist'));
  return {
    id: 'php',
    dir: '',
    name: `PHP${tags.includes('laravel') ? ' (Laravel)' : tags.includes('symfony') ? ' (Symfony)' : ''}`,
    test: phpunit ? (existsSync(path.join(dir, 'artisan')) ? 'php artisan test' : 'php vendor/bin/phpunit') : null,
    testFiles: phpunit ? 'php vendor/bin/phpunit {files}' : null,
    lint: null,
    typecheck: phpstan ? 'php vendor/bin/phpstan analyse --no-progress' : null,
    tags,
  };
}

function rubyStack(dir: string): Stack | null {
  const gemfile = path.join(dir, 'Gemfile');
  if (!existsSync(gemfile)) return null;
  const text = read(gemfile);
  const tags = ['ruby', ...['rails', 'rspec', 'sinatra', 'sidekiq'].filter((t) => text.includes(t))];
  const spec = existsSync(path.join(dir, 'spec'));
  return {
    id: 'ruby',
    dir: '',
    name: `Ruby${tags.includes('rails') ? ' (Rails)' : ''}`,
    test: spec ? 'bundle exec rspec' : existsSync(path.join(dir, 'test')) ? (tags.includes('rails') ? 'bin/rails test' : 'bundle exec rake test') : null,
    testFiles: spec ? 'bundle exec rspec {files}' : null,
    lint: existsSync(path.join(dir, '.rubocop.yml')) ? 'bundle exec rubocop' : null,
    typecheck: null,
    tags,
  };
}

const DETECTORS = [nodeStack, pythonStack, goStack, rustStack, jvmStack, dotnetStack, phpStack, rubyStack];

/** Подпроекты в корне и на 1–2 уровня ниже (backend/, frontend/, services/api/). */
export function detectStacks(root: string): Stack[] {
  const out: Stack[] = [];
  const visit = (rel: string, depth: number) => {
    const abs = path.join(root, rel);
    let found = false;
    for (const d of DETECTORS) {
      const s = d(abs);
      // пакеты workspace внутри node-проекта — его часть, их проверяет корневой npm test
      if (s && rel && s.id === 'node' && out.some((o) => o.id === 'node' && o.dir === '')) continue;
      if (s) {
        out.push({ ...s, dir: rel.split(path.sep).join('/') });
        found = true;
      }
    }
    // подпроекты ищем только в папках без своего манифеста (вложенные пакеты внутри проекта — его часть)
    if (depth >= 2 || (found && rel)) return;
    let names: string[] = [];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const n of names) {
      if (SKIP.has(n) || n.startsWith('.')) continue;
      try {
        if (statSync(path.join(abs, n)).isDirectory()) visit(rel ? path.join(rel, n) : n, depth + 1);
      } catch {
        /* нет доступа */
      }
    }
  };
  visit('', 0);
  return out;
}

/** Команда части проекта: из корня заходим в папку подпроекта. */
function inDir(dir: string, cmd: string | null): string | null {
  if (!cmd) return null;
  return dir ? `cd "${dir}" && ${cmd}` : cmd;
}

/** Команды всего проекта: одна часть — как есть; несколько — составная, части через MULTI. */
export function combinedCommands(stacks: Stack[]): { test: string | null; testFiles: string | null; lint: string | null; typecheck: string | null } {
  const join = (key: 'test' | 'lint' | 'typecheck') => {
    const parts = stacks.map((s) => inDir(s.dir, s[key])).filter((x): x is string => !!x);
    return parts.length ? parts.join(MULTI) : null;
  };
  const single = stacks.length === 1 && !stacks[0]!.dir;
  return { test: join('test'), testFiles: single ? stacks[0]!.testFiles : null, lint: join('lint'), typecheck: join('typecheck') };
}

/** Язык файла по расширению — для памяток кодеру и синтаксической проверки. */
export function langOf(file: string): string | null {
  const ext = path.extname(file).slice(1).toLowerCase();
  const base = path.basename(file);
  if (/^Dockerfile|^Containerfile/.test(base)) return 'docker';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'react', js: 'javascript', jsx: 'react', mjs: 'javascript', cjs: 'javascript', vue: 'vue', svelte: 'svelte',
    py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', cs: 'csharp', php: 'php', rb: 'ruby',
    sql: 'sql', yml: 'yaml', yaml: 'yaml', css: 'css', scss: 'css', less: 'css', html: 'html', sh: 'shell', ps1: 'powershell',
  };
  return map[ext] ?? null;
}
