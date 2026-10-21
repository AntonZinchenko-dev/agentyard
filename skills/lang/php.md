PHP:
- <?php в начале файла, declare(strict_types=1); если так в проекте; namespace по PSR-4 (как в composer.json).
- Типы параметров и возврата — как в соседних классах.
- Laravel: маршруты в routes/, логика в контроллерах/сервисах, валидация через $request->validate.
