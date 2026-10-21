// Рецепты подбираются по словам цели и составу проекта.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRecipes, loadRecipes } from '../src/recipes.ts';

const NEXT = ['next', 'react', 'react-dom'];
const names = (goal: string, deps = NEXT) => pickRecipes(goal, deps).map((r) => r.name);

test('рецепты загружаются и подбираются по цели и проекту', () => {
  assert.ok(loadRecipes().length >= 4);
  assert.deepEqual(names('натяни какую нибудь популярную юай библиотеку'), ['ui-kit']);
  assert.deepEqual(names('натяни юай библиотеку', ['express']), [], 'UI-кит для React — не для бэкенда');
  assert.deepEqual(names('в докере порт 8080 надо'), ['docker']);
  assert.deepEqual(names('чтоб шапка у таблиц не уезжала'), ['sticky']);
  assert.deepEqual(names('сделай тёмную тему'), ['dark-theme']);
  assert.deepEqual(names('сделай кнопки красными'), []);
  assert.deepEqual(names('build the guide'), [], '«ui» внутри слова — не UI');
});

test('база рецептов: бэк, фронт, инфраструктура; в тексте только строки своего стека', () => {
  const pick = (goal: string, tags: string[]) => pickRecipes(goal, tags);
  const go = pick('добавь эндпоинт для списка заказов', ['go', 'gin']);
  assert.ok(go.some((r) => r.name === 'api-endpoint'), go.map((r) => r.name).join());
  const ep = go.find((r) => r.name === 'api-endpoint')!.text;
  assert.match(ep, /Go: обработчик/);
  assert.doesNotMatch(ep, /FastAPI|Spring|Laravel/, 'чужие стеки модель не видит');
  assert.ok(pick('добавь колонку phone в таблицу users', ['python', 'django']).some((r) => r.name === 'db-migration' && /Django: поле в models\.py/.test(r.text)));
  assert.ok(pick('покрой тестами расчёт скидки', ['go']).some((r) => r.name === 'tests-add' && /_test\.go/.test(r.text)));
  assert.ok(pick('подними postgres в докере рядом с апи', ['node', 'express']).some((r) => r.name === 'compose'));
  assert.ok(pick('сделай нормально под телефон', ['node', 'next', 'react']).some((r) => r.name === 'responsive'));
  assert.ok(pick('валидация формы, email обязателен', ['node', 'react', 'react-hook-form', 'zod']).some((r) => r.name === 'form-validation' && /zodResolver/.test(r.text)));
  assert.deepEqual(pick('добавь импорт модуля', ['node']).map((r) => r.name).filter((n) => n === 'docker'), [], '«импорт» — не «порт»');
  assert.ok(loadRecipes().length >= 20);
});

test('памятки по языку: кодер на Go видит правила Go, на TSX — React и про use client', async () => {
  const { languageNotes } = await import('../src/agent.ts');
  assert.match(languageNotes(['internal/api/handler.go'])[0]!, /Неиспользуемые импорты/);
  const tsx = languageNotes(['app/layout.tsx', 'src/shared/ui/generated.css']).join('\n');
  assert.match(tsx, /'use client' НЕ ставить/);
  assert.match(tsx, /перебивает общее/);
  assert.equal(languageNotes(['a.py', 'b.go', 'c.rs']).length, 2, 'не больше двух памяток — контекст маленькой модели не резиновый');
});
