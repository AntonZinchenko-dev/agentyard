// Установка пакетов, которые нужны задаче («натяни UI-библиотеку» без этого невозможна).
// Ставим в node_modules проекта с --no-save: package.json пользователя не меняется, пока он не применит результат.
// В ветке прогона зависимость дописывается в package.json — это часть изменений, её видно в diff и на ревью.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runCommand } from './checks.ts';

/** Имя пакета npm с необязательной версией: react, @mantine/core, @mantine/core@7.17.0, zod@^3. Ничего лишнего — это идёт в командную строку. */
export const PKG_SPEC = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[a-z0-9.^~*+-]{1,40})?$/i;

export function validSpec(spec: string): boolean {
  return spec.length <= 120 && PKG_SPEC.test(spec);
}

/** Имя пакета без версии. */
export function pkgName(spec: string): string {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

export interface InstallResult {
  ok: boolean;
  output: string;
  /** Установленные версии: имя → версия. */
  versions: Record<string, string>;
  /** Что пришлось поменять, чтобы поставилось (свежие версии, --legacy-peer-deps). */
  note?: string;
}

/**
 * npm install --no-save в корне проекта. Команду можно подменить (AGENTYARD_NPM — путь к скрипту) — для тестов без сети.
 */
export async function installPackages(repo: string, specs: string[], timeoutMs = 10 * 60_000): Promise<InstallResult> {
  const bad = specs.filter((s) => !validSpec(s));
  if (bad.length) return { ok: false, output: `Недопустимые имена пакетов: ${bad.join(', ')}`, versions: {} };
  const wanted = dedupeSpecs(specs);
  // маленькие модели помнят старые версии (@mantine/core@7.0.0 при React 19) — npm отвечает ERESOLVE или «нет такой версии».
  // Тогда ставим свежие версии без закрепления, а если мешают peer-зависимости — с --legacy-peer-deps.
  const unpinned = [...new Set(wanted.map(pkgName))];
  const attempts: { specs: string[]; legacy: boolean; note: string }[] = [{ specs: wanted, legacy: false, note: '' }];
  if (unpinned.join() !== wanted.join()) attempts.push({ specs: unpinned, legacy: false, note: 'указанные версии не подошли — поставил свежие' });
  attempts.push({ specs: unpinned, legacy: true, note: 'свежие версии с --legacy-peer-deps: peer-зависимости пакета не совпали с проектом' });
  let last: InstallResult = { ok: false, output: '', versions: {} };
  for (const a of attempts) {
    last = await installOnce(repo, a.specs, a.legacy, timeoutMs);
    if (last.ok) return a.note ? { ...last, output: `${a.note}\n${last.output}`, note: a.note } : last;
    // 404, сеть, права — повторы с другими флагами не помогут
    if (!/ERESOLVE|peer dep|ETARGET|notarget|No matching version|conflicting peer/i.test(last.output)) return last;
  }
  return last;
}

/** Один пакет — одна строка: из «@x/core» и «@x/core@7.0.0» оставляем без версии (свежая версия надёжнее памяти модели). */
export function dedupeSpecs(specs: string[]): string[] {
  const byName = new Map<string, string>();
  for (const s of specs) {
    const name = pkgName(s);
    const prev = byName.get(name);
    if (!prev || (prev !== name && s === name)) byName.set(name, s);
  }
  return [...byName.values()];
}

async function installOnce(repo: string, specs: string[], legacy: boolean, timeoutMs: number): Promise<InstallResult> {
  const quoted = specs.map((s) => `"${s}"`).join(' ');
  const fake = process.env.AGENTYARD_NPM;
  const flags = legacy ? ' --legacy-peer-deps' : '';
  const cmd = fake ? `node "${fake}" install --no-save${flags} ${quoted}` : `npm install --no-save --no-audit --no-fund${flags} ${quoted}`;
  const r = await runCommand(cmd, repo, timeoutMs);
  const versions: Record<string, string> = {};
  for (const s of specs) {
    const pj = path.join(repo, 'node_modules', ...pkgName(s).split('/'), 'package.json');
    if (existsSync(pj)) versions[pkgName(s)] = (JSON.parse(readFileSync(pj, 'utf8')) as { version?: string }).version ?? '*';
  }
  const missing = specs.filter((s) => !versions[pkgName(s)]);
  if (r.code !== 0 || missing.length) {
    return { ok: false, output: `${missing.length ? `Не установились: ${missing.join(', ')}\n` : ''}${r.output.slice(-3000)}`, versions };
  }
  return { ok: true, output: r.output.slice(-1500), versions };
}

/** Дописать зависимости в package.json рабочей копии, сохранив отступы файла. */
export function addDependencies(dir: string, versions: Record<string, string>): boolean {
  const file = path.join(dir, 'package.json');
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  const indent = /\n(\s+)"/.exec(text)?.[1] ?? '  ';
  const pkg = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  let changed = false;
  for (const [name, version] of Object.entries(versions)) {
    if (pkg.devDependencies?.[name] || pkg.dependencies?.[name]) continue;
    pkg.dependencies = { ...(pkg.dependencies ?? {}), [name]: version === '*' ? '*' : `^${version}` };
    changed = true;
  }
  if (!changed) return false;
  pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(file, `${JSON.stringify(pkg, null, indent)}${text.endsWith('\n') ? '\n' : ''}`);
  return true;
}

/** Зависимости проекта для карты: модель должна знать, что уже есть, а что придётся ставить. */
export function projectDependencies(repo: string, dirs: string[] = ['']): string[] {
  return [...new Set(Object.keys(dependencyVersions(repo, dirs)))];
}

/** Зависимости с версиями из package.json корня и частей проекта (web/package.json…). */
export function dependencyVersions(repo: string, dirs: string[] = ['']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of new Set(['', ...dirs])) {
    const file = path.join(repo, d, 'package.json');
    if (!existsSync(file)) continue;
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      Object.assign(out, pkg.devDependencies ?? {}, pkg.dependencies ?? {});
    } catch {
      /* битый package.json */
    }
  }
  return out;
}
