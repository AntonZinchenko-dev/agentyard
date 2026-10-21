триггер: авториз|аутентиф|логин|вход (в|по)|jwt|токен|сесси|login|auth
проект: .*
---
Вход и доступ.

1. Не изобретать криптографию: пароли — bcrypt/argon2 из библиотеки проекта, токены — стандартная библиотека JWT; секрет — из переменной окружения.
2. Проверка доступа — в одном месте (middleware/guard/dependency), а не в каждом обработчике.
@express|fastify: 3. Node: middleware, читающий Authorization: Bearer, кладёт пользователя в req.user; 401 без токена, 403 без прав.
@nestjs: 3. NestJS: Guard + декоратор на контроллерах.
@fastapi: 3. FastAPI: Depends(get_current_user) с OAuth2PasswordBearer.
@spring: 3. Spring Security: SecurityFilterChain, правила по путям.
@aspnetcore: 3. ASP.NET Core: AddAuthentication().AddJwtBearer + [Authorize].
@next|react: 3. Фронт: токен — в httpOnly cookie (от сервера), не в localStorage; защищённые страницы проверяют сессию.
4. Не логировать пароли и токены.
