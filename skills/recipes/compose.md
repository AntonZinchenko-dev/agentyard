триггер: compose|postgres|постгрес|redis|редис|mysql|mongo|база.*(докер|контейнер)|поднять (базу|бд)
проект: .*
---
docker-compose: сервисы рядом с приложением.

1. Один файл docker-compose.yml в корне. Сервис базы: образ с конкретной версией (postgres:16-alpine), volume для данных, healthcheck (pg_isready / redis-cli ping).
2. Приложение: depends_on с condition: service_healthy; строка подключения через переменные окружения (DATABASE_URL), не зашита в код.
3. Пароли — через переменные и .env.example (сам .env не создавать и не коммитить).
4. Отступы в YAML — только пробелы.
