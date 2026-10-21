// Стек проекта: языки, подпроекты и команды проверки — без этого агент не может проверить себя.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { combinedCommands, detectStacks, langOf, MULTI } from '../src/stacks.ts';
import { buildRepoMap, renderRepoMap } from '../src/repomap.ts';
import { runCommand } from '../src/checks.ts';

function proj(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ay-stack-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test('стеки: Go, Rust, Python/FastAPI, Maven/Spring, .NET, Laravel, Rails — свои команды сборки и тестов', () => {
  const go = detectStacks(proj({ 'go.mod': 'module x\nrequire github.com/gin-gonic/gin v1.9.0\n', 'main.go': 'package main\n', 'h_test.go': 'package main\n' }));
  assert.equal(go[0]!.typecheck, 'go vet ./...');
  assert.equal(go[0]!.test, 'go test ./...');
  assert.ok(go[0]!.tags.includes('gin'));

  const rs = detectStacks(proj({ 'Cargo.toml': '[dependencies]\naxum = "0.7"\n' }));
  assert.equal(rs[0]!.typecheck, 'cargo check --quiet --all-targets');

  const py = detectStacks(proj({ 'pyproject.toml': '[project]\ndependencies=["fastapi"]\n[tool.mypy]\n', 'tests/test_a.py': '' }));
  assert.equal(py[0]!.name, 'Python (FastAPI)');
  assert.equal(py[0]!.test, 'python -m pytest -q');
  assert.equal(py[0]!.typecheck, 'python -m mypy .');

  const mvn = detectStacks(proj({ 'pom.xml': '<artifactId>spring-boot-starter-web</artifactId>', 'src/test/java/A.java': '' }));
  assert.match(mvn[0]!.name, /Maven, Spring Boot/);
  assert.match(mvn[0]!.test!, /mvn -q test/);

  const net = detectStacks(proj({ 'Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>', 'tests/Api.Tests/Api.Tests.csproj': '<Project/>' }));
  assert.equal(net[0]!.name, '.NET (ASP.NET Core)');
  assert.equal(net[0]!.test, 'dotnet test --nologo -v q');

  const php = detectStacks(proj({ 'composer.json': '{"require":{"laravel/framework":"^11"}}', 'phpunit.xml': '', artisan: '' }));
  assert.equal(php[0]!.test, 'php artisan test');

  const rb = detectStacks(proj({ Gemfile: "gem 'rails'\ngem 'rspec-rails'\n", 'spec/a_spec.rb': '' }));
  assert.equal(rb[0]!.test, 'bundle exec rspec');
});

test('monorepo: backend на Go и frontend на Node — составные команды, каждая в своей папке', async () => {
  const root = proj({
    'backend/go.mod': 'module api\n',
    'backend/main.go': 'package main\n\nfunc Handler(w int) {}\n',
    'frontend/package.json': JSON.stringify({ scripts: { test: 'node --test' }, dependencies: { next: '15' } }),
    'frontend/app/page.tsx': 'export default function Page() { return null }\n',
  });
  const stacks = detectStacks(root);
  assert.deepEqual(stacks.map((s) => [s.dir, s.id]).sort(), [['backend', 'go'], ['frontend', 'node']]);
  const cmds = combinedCommands(stacks);
  assert.equal(cmds.typecheck, 'cd "backend" && go vet ./...');
  assert.ok(cmds.test!.includes(MULTI) || cmds.test === 'cd "frontend" && npm test');
  const map = buildRepoMap(root);
  assert.ok(map.languages.includes('Go'));
  assert.deepEqual(map.symbols['backend/main.go'], ['Handler(w int)']);
  assert.ok(map.tags!.includes('next'));
  assert.match(renderRepoMap(map), /Части проекта: backend — Go; frontend — Node \(Next\.js\)/);

  // составная команда: выполняются все части, падает, если упала любая
  const ok = await runCommand(`node -e "console.log(1)"${MULTI}node -e "console.log(2)"`, root);
  assert.equal(ok.code, 0);
  assert.match(ok.output, /1[\s\S]*2/);
  const bad = await runCommand(`node -e "process.exit(3)"${MULTI}node -e "console.log('второй')"`, root);
  assert.notEqual(bad.code, 0);
  assert.match(bad.output, /второй/, 'вторая часть тоже запущена — ошибки всех частей видны сразу');
});

test('язык файла — для памяток кодеру', () => {
  assert.equal(langOf('src/a.go'), 'go');
  assert.equal(langOf('app/page.tsx'), 'react');
  assert.equal(langOf('Dockerfile'), 'docker');
  assert.equal(langOf('x.unknown'), null);
});

test('ошибки сборки разных языков: номера строк не делают старую ошибку «новой»', async () => {
  const { errorLines, errorLineKey } = await import('../src/checks.ts');
  const go = errorLines('# api\n./main.go:10:2: undefined: foo\nok\n');
  assert.deepEqual(go, ['./main.go:10:2: undefined: foo']);
  assert.equal(errorLineKey('./main.go:10:2: undefined: foo'), errorLineKey('./main.go:42:7: undefined: foo'));
  assert.equal(errorLineKey('Program.cs(10,5): error CS0103: The name x does not exist [Api.csproj]'), 'Program.cs|CS0103');
  assert.equal(errorLineKey('[ERROR] /src/A.java:[10,5] cannot find symbol'), errorLineKey('[ERROR] /src/A.java:[12,9] cannot find symbol'));
  assert.equal(errorLineKey('app/x.py:10: error: Incompatible types'), errorLineKey('app/x.py:31: error: Incompatible types'));
  assert.deepEqual(errorLines('e: file:///a/B.kt:3:1 Unresolved reference: x'), ['e: file:///a/B.kt:3:1 Unresolved reference: x']);
});

test('синтаксис Python ловится сразу, до сборки; нет утилиты — ступень не мешает', async () => {
  const { runCascade } = await import('../src/checks.ts');
  const root = proj({ 'a.py': 'def f(:\n  pass\n', 'b.py': 'def g():\n    return 1\n', 'c.yml': 'a:\n\tb: 1\n' });
  const task = { id: 'T1', type: 'edit', title: '', brief: '', dependsOn: [], files: [], accept: { tests: [], commands: [] }, size: 'S', frozenFiles: [] } as any;
  const cmds = { test: null, testFiles: null, lint: null, typecheck: null };
  const bad = await runCascade({ task, workdir: root, changedFiles: ['a.py'], changedLines: 1, maxChangedLines: 80, commands: cmds });
  assert.equal(bad.passed, false);
  assert.equal(bad.stageName, 'синтаксис');
  const ok = await runCascade({ task, workdir: root, changedFiles: ['b.py'], changedLines: 1, maxChangedLines: 80, commands: cmds });
  assert.equal(ok.passed, true, ok.output);
  const yml = await runCascade({ task, workdir: root, changedFiles: ['c.yml'], changedLines: 1, maxChangedLines: 80, commands: cmds });
  assert.match(yml.output, /табуляцией/);
});
