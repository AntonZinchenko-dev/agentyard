триггер: healthcheck|health|живост|проверк.{0,8}(работ|здоров)|readiness|liveness
проект: .*
---
Проверка здоровья сервиса.

1. Эндпоинт GET /health (или /healthz) → 200 {"status":"ok"} без авторизации; /ready может проверять базу.
2. Тот же путь — в HEALTHCHECK Dockerfile или healthcheck в docker-compose.
