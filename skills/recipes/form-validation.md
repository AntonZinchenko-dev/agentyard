триггер: валидац|обязательн.*пол|проверк.*(пол|форм|ввод)|validation|zod|yup
проект: .*
---
Проверка ввода в форме или в API.

@react-hook-form|zod: 1. Фронт с react-hook-form + zod: правила — в схеме zod (z.string().min(1, 'Обязательное поле'), .email('Неверный email')), resolver: zodResolver(schema); текст ошибки показывать из formState.errors.<поле>?.message рядом с полем.
@react|vue|svelte|angular: 2. Сообщения об ошибках — по-русски, рядом с полем; кнопка отправки не блокируется навсегда.
@fastapi|pydantic: 1. FastAPI: правила — в модели Pydantic (Field(min_length=1), EmailStr); FastAPI сам вернёт 422.
@express|fastify|nestjs: 1. Node API: проверка тела запроса схемой (zod / class-validator в NestJS) в начале обработчика; ошибка — 400 с понятным сообщением.
@spring: 1. Spring: аннотации @NotBlank/@Email на полях DTO и @Valid у параметра контроллера.
@aspnetcore: 1. ASP.NET Core: атрибуты [Required], [EmailAddress] у модели; [ApiController] сам вернёт 400.
@laravel: 1. Laravel: $request->validate([...]) или FormRequest с rules().
@django: 1. Django: правила в Form/Serializer (required, validators), ошибки из form.errors.
3. Одна задача на схему/модель и одна — на показ ошибок (если это фронт). Логику сохранения не трогать.
