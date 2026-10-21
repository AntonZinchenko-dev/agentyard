триггер: юай|\bui\b|ui-?кит|библиотек|mantine|мантин|antd|ant design|material|\bmui\b|chakra|bootstrap|бутстрап
проект: react|next
---
Подключение UI-кита к проекту на React/Next.js.

1. Если человек не назвал конкретную библиотеку — бери Mantine: пакеты "@mantine/core" и "@mantine/hooks". install ставь у задачи с провайдером (отдельной задачи «установить пакеты» не делай — пакеты ставит программа).
2. Задача 1 (install + провайдер), файл app/layout.tsx. 'use client' в app/layout.tsx НЕ добавлять (там export const metadata — Next.js это запрещает; MantineProvider и так клиентский). Добавить import '@mantine/core/styles.css' и import { MantineProvider } from '@mantine/core'; обернуть {children} в <MantineProvider>…</MantineProvider>. Без пропсов theme/colorScheme (в Mantine 7+ их нет — будет ошибка типов). Провайдер один, в общем layout — не на каждой странице.
3. Задача 2 (таблицы), правка по образцу: similar = шаблон страниц-списков (например src/pages/*-list/ui/*Page.tsx), в files — один файл-образец. Заплатки с "all": true, по порядку:
   <table className="af-table"> → <Table striped highlightOnHover withTableBorder>; </table> → </Table>;
   <thead> → <Table.Thead>; </thead> → </Table.Thead>; <tbody> → <Table.Tbody>; </tbody> → </Table.Tbody>;
   <tr → <Table.Tr; </tr> → </Table.Tr>; <th> → <Table.Th>; </th> → </Table.Th>; <td → <Table.Td; </td> → </Table.Td>.
   И одна обычная заплатка: после строки import Link from 'next/link' добавить import { Table } from '@mantine/core' (или { Button, Table }, если в той же задаче кнопки).
4. Задача 3 (кнопки), тоже similar: <button className="af-btn" → <Button variant="default" и </button> → </Button> (обе с "all": true); <button className="af-btn primary" → <Button; <button className="af-btn danger" → <Button color="red".
   Ссылка-кнопка <Link className="af-btn primary" href="…">Добавить</Link> → <Button component={Link} href="…">Добавить</Button> — заплаткой с соседними строками (надпись и </Link>), не через all: у обычных ссылок в таблице тоже </Link>.
   Добавить import { Button } from '@mantine/core'. Обработчики, disabled, href, type — сохранить.
4б. Шапка (меню), если о ней просят: файл меню (например src/widgets/generated-nav/ui/GeneratedNav.tsx). Ссылки <Link …>…</Link> → <Button component={Link} href={…} variant="subtle">…</Button>, контейнер <nav> → <Group component="nav" gap="xs">; добавить import { Button, Group } from '@mantine/core'. Список пунктов и адреса не менять.
5. Логику (запросы, формы, валидацию) не трогать. Общий CSS (generated.css) НЕ удалять и не очищать — им оформлено всё, что не заменено (страница, шапка, фильтры, формы).
6. Файлы app/(generated)/*/page.tsx — обёртки (только import/export), в них менять нечего.
7. Проект из частей (web/ + backend/): все пути — от корня проекта (web/app/layout.tsx, web/src/pages/*-list/ui/*Page.tsx), пакеты программа ставит в web/. Тестов для web не планируй, если в web нет запуска тестов.
