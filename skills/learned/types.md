# Копилка решений: Типы и сборка

Пишет AgentYard: ошибка, на которой падала задача, и что помогло, когда она прошла. Можно править руками; формат — заголовок ## и строки «- теги:», «- ошибка:», «- решение:».

## TS2353 / TS2322: 'colorScheme' нет в теме и пропсах MantineProvider (Mantine 7+)
<!-- id: ts2353-colorscheme-mantine -->
- теги: ts2353, ts2322, colorscheme, mantine, mantine@7, mantine@8, mantine@9, mantinetheme, mantineproviderprops, tsx
- ошибка: error TS2353: Object literal may only specify known properties, and 'colorScheme' does not exist in type 'PartialObjectDeep<MantineTheme, …>'
- решение:
  - в Mantine 7+ цветовая схема — не часть theme: убери colorScheme из theme
  - на MantineProvider: defaultColorScheme="light" | "dark" | "auto" (или forceColorScheme), а в theme оставь primaryColor и т. п.
- пример:
  ```diff
  -    <MantineProvider theme={{ colorScheme: 'dark', primaryColor: 'blue' }}>
  +    <MantineProvider defaultColorScheme="dark" theme={{ primaryColor: 'blue' }}>
  ```
- источники: https://mantine.dev/theming/color-schemes/
- встречалось: 1 раз(а), последний 2026-10-20 (заведено вручную по прогону 20261020100147, D2.3)
