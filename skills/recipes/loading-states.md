триггер: загрузк|спиннер|скелет|loader|loading|ошибк.{0,10}(загруз|запрос|сети)|пуст(о|ое состояние)
проект: react|vue|svelte|angular|next|nuxt
---
Состояния загрузки, ошибки и пустого списка.

@@tanstack/react-query: 1. React Query: isLoading/isError/error из useQuery; показывать «Загрузка…»/скелет, сообщение об ошибке с кнопкой «Повторить» (refetch), «Пока пусто» при пустом списке.
2. Один общий компонент (Loader/ErrorState/EmptyState) в shared, страницы используют его — правкой по образцу (similar).
