триггер: cors|кросс.?домен|блокирует запрос|access-control
проект: .*
---
CORS.

1. Разрешённые источники — список из переменной окружения (например, CORS_ORIGINS), не «*» вместе с cookies.
@express: 2. Express: пакет cors с origin: списком, до роутов.
@fastapi: 2. FastAPI: app.add_middleware(CORSMiddleware, allow_origins=[…]).
@spring: 2. Spring: WebMvcConfigurer.addCorsMappings или CorsConfigurationSource.
@aspnetcore: 2. ASP.NET Core: AddCors + UseCors с политикой.
@go: 2. Go: middleware, выставляющий Access-Control-Allow-* и отвечающий на OPTIONS.
