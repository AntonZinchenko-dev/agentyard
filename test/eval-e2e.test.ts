// Сквозной экзамен: все сценарии «пьяного теста» через настоящий конвейер на толковой учебной модели.
// Модель отвечает ТОЛЬКО из того, что ей прислала программа: файл — из «Где это в коде», текст для замены —
// из показанного содержимого файла, шаблон — из «Однотипных файлов». Не дошло нужное до запроса — экзамен не сдан.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, runEval } from '../src/eval.ts';
import { MockRuntime } from '../src/runtime/mock.ts';
import { demoScript, featureScript } from '../src/demo.ts';
import { Pipeline } from '../src/pipeline.ts';
import { loadCatalog } from '../src/catalog.ts';
import { Stats } from '../src/stats.ts';
import type { ChatMessage, ChatRequest } from '../src/runtime/types.ts';
import type { Hardware } from '../src/types.ts';

process.env.AGENTYARD_NPM = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-npm.mjs');
const HW: Hardware = { gpuName: 'test', vramTotalGb: 48, vramFreeGb: 48, ramTotalGb: 64, ramFreeGb: 32, cpuCores: 8, unifiedMemory: false, tier: 'T3' };

const section = (text: string, title: RegExp): string => {
  const m = new RegExp(`## ${title.source}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`).exec(text);
  return m?.[m.length - 1]?.trim() ?? '';
};
/** Файлы, показанные модели: «## Файл X» + блок кода. */
const shownFiles = (text: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/## Файл ([^\n]+?)(?: \(ЗАМОРОЖЕН[^\n]*)?\n+```[a-z]*\n([\s\S]*?)\n```/g)) out.set(m[1]!.trim(), m[2]!);
  return out;
};

function competent(): (req: ChatRequest) => ChatMessage {
  const feature = featureScript();
  const demo = demoScript();
  return (req) => {
    const system = req.messages[0]?.content ?? '';
    const user = req.messages[1]?.content ?? '';
    const json = (o: unknown): ChatMessage => ({ role: 'assistant', content: JSON.stringify(o) });
    const goal = section(user, /(Цель|Общая цель)/);
    if (/промокод/i.test(goal) || /промокод|promo/i.test(user.slice(0, 4000)) && system.includes('тестировщик')) return feature(req);
    if (/Починить test\//.test(user) || (!goal && (system.includes('кодер') || system.includes('ревьюер')))) return demo(req);

    if (system.includes('приёмщик')) {
      const diff = section(user, /Итоговые изменения/);
      return json(diff && !/изменений в файлах НЕТ/.test(diff) ? { achieved: true, missing: [], tasks: [] } : { achieved: false, missing: ['ничего не изменено'], tasks: [] });
    }
    if (system.includes('ревьюер')) return json({ verdict: 'approve', reasons: [] });

    if (system.includes('планировщик')) {
      const hits = [...section(user, /Где это/).matchAll(/^- (\S+)/gm)].map((m) => m[1]!);
      const twins = [...section(user, /Карта проекта/).matchAll(/^- (\S*\*\S*) — \d+ шт\./gm)].map((m) => m[1]!);
      const pagesTpl = twins.find((t) => /Page\.tsx$/.test(t));
      const examplePage = 'src/pages/address-list/ui/AddressListPage.tsx';
      const task = (extra: Record<string, unknown>) => ({ id: 'T1', type: 'edit', title: goal.slice(0, 40), brief: goal, dependsOn: [], accept: { tests: [], commands: [] }, size: 'S', ...extra });
      if (/юай|библиотек/i.test(goal)) {
        assert.ok(pagesTpl, 'в карте нет шаблона однотипных страниц');
        assert.match(user, /Рецепт для такой задачи[\s\S]*MantineProvider/, 'планировщику не дан рецепт UI-кита');
        return json({ understanding: 'Поставить Mantine и использовать его на страницах', tasks: [task({ files: [examplePage], similar: pagesTpl, install: ['@mantine/core'] })] });
      }
      if (/везде/i.test(goal)) {
        assert.ok(pagesTpl, 'в карте нет шаблона однотипных страниц');
        return json({ understanding: 'На всех страницах кнопка «Создать»', tasks: [task({ files: [examplePage], similar: pagesTpl })] });
      }
      assert.ok(hits.length, `поиск ничего не нашёл для «${goal}»`);
      return json({ understanding: goal, tasks: [task({ files: [hits[0]] })] });
    }

    if (system.includes('кодер')) {
      const files = shownFiles(user);
      const [file, text] = [...files][0] ?? [];
      assert.ok(file && text !== undefined, 'кодеру не показан файл');
      const lines = text!.split('\n');
      const lineWith = (s: string) => lines.find((l) => l.includes(s));
      let patch: { file: string; search: string; replace: string } | null = null;
      if (/красн/i.test(goal)) {
        const l = lineWith('.af-btn.primary');
        if (l) patch = { file: file!, search: l, replace: '.af-btn.primary { background: #d32f2f; border-color: #d32f2f; color: #fff; }' };
      } else if (/тёмн|темн/i.test(goal)) {
        const l = lines.filter(Boolean).at(-1)!;
        patch = { file: file!, search: l, replace: `${l}\n@media (prefers-color-scheme: dark) {\n  body, .af-page { background: #121417; color: #e6e8eb; }\n}` };
      } else if (/шапк/i.test(goal)) {
        const l = lineWith('.af-table th {') ?? lines.filter(Boolean).at(-1)!;
        patch = { file: file!, search: l, replace: `${l}\n.af-table th { position: sticky; top: 0; background: #fff; }` };
      } else if (/заголовок/i.test(goal)) {
        patch = { file: file!, search: '<h1>Адреса</h1>', replace: '<h1>Адреса доставки</h1>' };
      } else if (/Создать/.test(goal)) {
        patch = { file: file!, search: '          Добавить\n', replace: '          Создать\n' };
      } else if (/порт/i.test(goal)) {
        patch = { file: file!, search: '', replace: text!.replace(/3000/g, '8080') };
      } else if (/юай|библиотек/i.test(goal)) {
        patch = { file: file!, search: "import Link from 'next/link'", replace: "import Link from 'next/link'\nimport { Button } from '@mantine/core'" };
      }
      assert.ok(patch, `кодер не понял, что делать: ${goal} / ${file}`);
      return json({ patches: [patch], note: 'готово' });
    }
    return json({});
  };
}

test('экзамен целиком на толковой учебной модели: все сценарии сданы', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ay-e2e-'));
  const rows = await runEval(root, async (repo, goal) =>
    new Pipeline({
      repo,
      goal,
      runtime: new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], competent()),
      catalog: loadCatalog(),
      hardware: HW,
      stats: new Stats(null),
      quiet: true,
      autoApply: true,
      allowInstall: true,
    }).run(),
  );
  const failed = rows.filter((r) => !r.pass);
  assert.equal(failed.length, 0, failed.map((r) => `${r.id}: ${r.error ?? r.why}`).join('\n'));
  assert.equal(rows.length, SCENARIOS.length);
});

test('мелкая правка конфига (порт в Dockerfile) — без отдельного ревью и без лишней смены модели', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ay-e2e2-'));
  let reviews = 0;
  const base = competent();
  const rows = await runEval(
    root,
    async (repo, goal) =>
      new Pipeline({
        repo,
        goal,
        runtime: new MockRuntime([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], (req) => {
          if ((req.messages[0]?.content ?? '').includes('ревьюер')) reviews += 1;
          return base(req);
        }),
        catalog: loadCatalog(),
        hardware: HW,
        stats: new Stats(null),
        quiet: true,
        autoApply: true,
      }).run(),
    ['web-docker-port'],
  );
  assert.equal(rows[0]!.pass, true, rows[0]!.why);
  assert.equal(reviews, 0);
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(path.join(rows[0]!.runDir!, 'journal.txt'), 'utf8'), /Ревью T1 не нужно: мелкая правка/);
});
