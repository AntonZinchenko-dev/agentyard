триггер: (покр|напиш|добав).{0,12}тест|тест(ы|ами) на|unit.?test|юнит|coverage|покрыти
проект: .*
---
Добавить тесты.

1. Пиши тем же раннером и в том же стиле, что уже есть в проекте (смотри существующий тестовый файл); если тестов нет — самый стандартный для стека.
@node: 2. Node: node:test + node:assert, если в package.json test: node --test; иначе vitest/jest — как в проекте. Файл рядом: *.test.ts.
@python: 2. Python: pytest, файл tests/test_<модуль>.py, функции test_*, проверки через assert.
@go: 2. Go: файл <имя>_test.go в том же пакете, func TestXxx(t *testing.T), табличные тесты.
@rust: 2. Rust: #[cfg(test)] mod tests в том же файле или tests/*.rs.
@java|kotlin: 2. JVM: JUnit 5 в src/test/… тем же пакетом.
@dotnet: 2. .NET: проект *.Tests (xUnit/NUnit — как в решении), [Fact]/[Test].
@php: 2. PHP: PHPUnit, tests/…Test.php, методы test*.
@ruby: 2. Ruby: RSpec spec/…_spec.rb или minitest — как в проекте.
3. На каждое требование — своя проверка с конкретными значениями: обычный случай, граница, ошибка. Не менять код ради теста, если задача — только тесты.
