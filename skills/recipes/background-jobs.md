триггер: фонов|очеред|задач.{0,6}по расписан|cron|крон|воркер|worker|celery|sidekiq|bull
проект: .*
---
Фоновые задачи и расписание.

@celery|python: 1. Python: Celery-задача (@shared_task) или APScheduler — как в проекте; задача идемпотентна.
@sidekiq|ruby: 1. Rails: ActiveJob/Sidekiq worker с perform.
@node: 1. Node: BullMQ (если есть redis) или node-cron; обработчик отдельно от HTTP.
@spring: 1. Spring: @Scheduled(cron = "…") в @Component + @EnableScheduling.
@go: 1. Go: time.Ticker в горутине с context для остановки.
2. Ошибки задачи логируются, повторы ограничены.
