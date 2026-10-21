триггер: эндпоинт|endpoint|ручк|(^|[^а-яё])api(?![а-яё])|роут|маршрут|crud|rest
проект: .*
---
Новый эндпоинт API.

1. Найди, как сделаны существующие обработчики (карта проекта, похожий файл), и повтори их устройство: тот же роутер, тот же формат ответа и ошибок.
@express: 2. Express: router.get/post в файле роутов этой сущности, подключение через app.use('/api/…', router); async-ошибки — через next(err).
@nestjs: 2. NestJS: метод в контроллере (@Get/@Post), логика в сервисе, DTO для тела.
@fastapi: 2. FastAPI: @router.get/post с response_model, роутер подключён в main через include_router.
@django: 2. Django: view + запись в urls.py (или ViewSet + router в DRF).
@flask: 2. Flask: @bp.route в blueprint, jsonify в ответе.
@gin|echo|fiber|chi|go: 2. Go: обработчик func(w http.ResponseWriter, r *http.Request) (или gin.Context) + регистрация маршрута там же, где остальные; ошибки — http.Error / c.JSON(статус, …).
@spring: 2. Spring: метод в @RestController (@GetMapping/@PostMapping), логика в @Service.
@aspnetcore: 2. ASP.NET Core: действие в контроллере [HttpGet]/[HttpPost] или app.MapGet в Program.cs — как в проекте.
@laravel: 2. Laravel: Route::get/post в routes/api.php + метод контроллера.
@rails: 2. Rails: маршрут в config/routes.rb + действие контроллера, render json:.
3. Тест на эндпоинт (если в проекте есть тесты) — по образцу существующих тестов API: тот же клиент (supertest, TestClient, httptest, MockMvc).
4. Задачи: обработчик+маршрут одной задачей, тест — отдельной (testFirst).
