триггер: миграц|колонк|столбец|поле в (таблиц|бд|базе|модел)|новая таблиц|схем.*(бд|баз)|migration
проект: .*
---
Изменение схемы базы.

1. Схему меняет НОВАЯ миграция; старые миграции не редактировать.
@prisma: 2. Prisma: правка schema.prisma; файл миграции создаёт человек командой npx prisma migrate dev — в задаче только схема и код, который использует поле.
@alembic|sqlalchemy: 2. SQLAlchemy/Alembic: поле в модели + новый файл в alembic/versions с upgrade()/downgrade() (down_revision = последняя ревизия).
@django: 2. Django: поле в models.py + миграция в app/migrations (номер следующий по порядку, dependencies на предыдущую).
@spring|hibernate: 2. Spring: поле в @Entity + миграция Flyway (resources/db/migration/V<след>__описание.sql) или Liquibase — как в проекте.
@efcore: 2. EF Core: свойство в сущности; миграцию создаёт человек командой dotnet ef migrations add — в задаче модель и код.
@laravel: 2. Laravel: новый файл в database/migrations с up()/down() + $fillable в модели.
@rails: 2. Rails: новый файл db/migrate/<время>_add_….rb с change + модель.
@go: 2. Go: SQL-миграция (migrations/NNN_*.up.sql и .down.sql) по образцу существующих.
3. Новое поле — с безопасным значением по умолчанию или nullable, чтобы миграция прошла на заполненной таблице.
