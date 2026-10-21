триггер: докер|docker|контейнер|(^|[^а-яё])порт|\bport\b
проект: .*
---
Правки Docker.

1. Порт меняется согласованно во всех местах: Dockerfile (ENV PORT=…, EXPOSE …, флаг -p/--port в CMD), скрипт dev/start (package.json), docker-compose.yml (ports: "X:X"), код сервера, если порт там прописан числом.
@node: 2. Node: npm ci вместо npm install, если есть package-lock.json; слой зависимостей (COPY package*.json + npm ci) — до COPY . . для кэша.
@python: 2. Python: pip install --no-cache-dir -r requirements.txt до COPY . .; запуск uvicorn/gunicorn с --host 0.0.0.0.
@go: 2. Go: многоступенчатая сборка (golang:… AS build → distroless/alpine), CGO_ENABLED=0.
3. Одна задача: Dockerfile (+ package.json/docker-compose.yml, если там тоже порт). Файл небольшой — можно прислать целиком.
