C#:
- Пространство имён — как у соседних файлов (file-scoped namespace X;, если так в проекте).
- async/await до конца: Task, а не .Result/.Wait().
- Nullable-ссылки включены в большинстве проектов: string? и проверки на null.
- Зависимости — через конструктор (внедрение), регистрация в Program.cs.
- Тесты — xUnit [Fact]/[Theory] или NUnit [Test] — как в решении.
