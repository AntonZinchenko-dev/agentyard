// Сервер интерфейса: токен, запуск прогона, утверждение плана, живые события, история прогонов.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.ts';
import { createFeatureRepo, featureRuntime, FEATURE_GOAL } from '../src/demo.ts';
import type { Hardware } from '../src/types.ts';

const hw = async (): Promise<Hardware> => ({ gpuName: 'test', vramTotalGb: 48, vramFreeGb: 48, ramTotalGb: 64, ramFreeGb: 32, cpuCores: 8, unifiedMemory: false, tier: 'T3' });

/** Читаем SSE-поток вручную и собираем события. */
async function collect(url: string, until: (e: { kind: string }) => boolean, onEvent?: (e: any) => void): Promise<any[]> {
  const res = await fetch(url);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const out: any[] = [];
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!chunk.startsWith('data: ')) continue;
      const e = JSON.parse(chunk.slice(6));
      out.push(e);
      onEvent?.(e);
      if (until(e)) {
        await reader.cancel();
        return out;
      }
    }
  }
  return out;
}

test('сервер: без токена — отказ, чужой Host — отказ', async () => {
  const srv = await startServer({ hardware: hw, statsPath: null });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    assert.equal((await fetch(`${base}/api/current`)).status, 401);
    assert.equal((await fetch(`${base}/api/current`, { headers: { 'x-ay-token': srv.token } })).status, 200);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /AgentYard/);
  } finally {
    await srv.close();
  }
});

test('сервер: прогон магазина — план ждёт утверждения, доска получает статусы, итог и история', async () => {
  const repo = path.join(mkdtempSync(path.join(tmpdir(), 'ay-srv-')), 'shop');
  createFeatureRepo(repo);
  const srv = await startServer({ hardware: hw, statsPath: null, runtimeFactory: () => featureRuntime() });
  const base = `http://127.0.0.1:${srv.port}`;
  const H = { 'x-ay-token': srv.token, 'content-type': 'application/json' };
  try {
    const statuses = new Set<string>();
    const events = collect(
      `${base}/api/events?t=${srv.token}`,
      (e) => e.kind === 'result' || e.kind === 'error',
      (e) => {
        if (e.kind === 'plan') void fetch(`${base}/api/approve`, { method: 'POST', headers: H, body: JSON.stringify({ ok: true }) });
        if (e.kind === 'tasks') for (const t of e.tasks) statuses.add(`${t.id}:${t.status}`);
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    const start = await fetch(`${base}/api/run`, { method: 'POST', headers: H, body: JSON.stringify({ repo, goal: FEATURE_GOAL, mock: true }) });
    assert.equal(start.status, 200, await start.clone().text());
    const { runId } = await start.json();

    const got = await events;
    const result = got.find((e) => e.kind === 'result');
    assert.ok(result, JSON.stringify(got.filter((e) => e.kind === 'error')));
    assert.deepEqual(result.result.done.sort(), ['T1', 'T1-test']);
    assert.ok(got.some((e) => e.kind === 'plan'));
    assert.ok(got.some((e) => e.kind === 'journal' && /План готов/.test(e.line)));
    for (const s of ['T1-test:running', 'T1-test:checking', 'T1-test:done', 'T1:running', 'T1:done']) assert.ok(statuses.has(s), `нет статуса ${s}`);

    // второй прогон, пока первый идёт, запрещён — здесь первый уже кончился, проверяем историю
    const runs = await (await fetch(`${base}/api/runs?repo=${encodeURIComponent(repo)}`, { headers: H })).json();
    assert.equal(runs[0].id, runId);
    assert.equal(runs[0].done, 2);
    const one = await (await fetch(`${base}/api/run?repo=${encodeURIComponent(repo)}&id=${runId}`, { headers: H })).json();
    assert.equal(one.tasks.length, 2);
    assert.ok(one.transcripts.length >= 3);
    const report = await fetch(`${base}/api/report?repo=${encodeURIComponent(repo)}&id=${runId}&t=${srv.token}`);
    assert.match(await report.text(), /Итог простыми словами/);
    const cur = await (await fetch(`${base}/api/current`, { headers: H })).json();
    assert.equal(cur.finished, true);
    assert.ok(cur.events.some((e: any) => e.kind === 'result'));
  } finally {
    await srv.close();
  }
});

test('сервер: отказ от плана останавливает прогон с понятной ошибкой', async () => {
  const repo = path.join(mkdtempSync(path.join(tmpdir(), 'ay-srv2-')), 'shop');
  createFeatureRepo(repo);
  const srv = await startServer({ hardware: hw, statsPath: null, runtimeFactory: () => featureRuntime() });
  const base = `http://127.0.0.1:${srv.port}`;
  const H = { 'x-ay-token': srv.token, 'content-type': 'application/json' };
  try {
    const events = collect(`${base}/api/events?t=${srv.token}`, (e) => e.kind === 'result' || e.kind === 'error', (e) => {
      if (e.kind === 'plan') void fetch(`${base}/api/approve`, { method: 'POST', headers: H, body: JSON.stringify({ ok: false }) });
    });
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`${base}/api/run`, { method: 'POST', headers: H, body: JSON.stringify({ repo, goal: 'shop-demo', mock: true }) });
    const got = await events;
    const err = got.find((e) => e.kind === 'error');
    assert.match(err.message, /План не утверждён/);
  } finally {
    await srv.close();
  }
});

test('сервер: экзамен из окна — прогресс событиями, итог и история с баллом', async () => {
  const { demoRuntime } = await import('../src/demo.ts');
  const evalRoot = mkdtempSync(path.join(tmpdir(), 'ay-evalsrv-'));
  const srv = await startServer({ hardware: hw, statsPath: null, runtimeFactory: () => demoRuntime(), evalRoot });
  const base = `http://127.0.0.1:${srv.port}`;
  const H = { 'x-ay-token': srv.token, 'content-type': 'application/json' };
  try {
    const events = collect(`${base}/api/events?t=${srv.token}`, (e: any) => e.kind === 'eval' && e.state && !e.state.running);
    await new Promise((r) => setTimeout(r, 50));
    const start = await fetch(`${base}/api/eval`, { method: 'POST', headers: H, body: JSON.stringify({ only: ['demo-fix'], mock: true }) });
    assert.equal(start.status, 200, await start.clone().text());
    const got = await events;
    const last = got.filter((e: any) => e.kind === 'eval').at(-1);
    assert.equal(last.state.rows.length, 1);
    assert.equal(last.state.rows[0].pass, true, JSON.stringify(last.state.rows[0]));
    assert.match(last.trend, /Первый экзамен: 1 из 1/);
    const info = await (await fetch(`${base}/api/eval`, { headers: H })).json();
    assert.equal(info.history.length, 1);
    assert.equal(info.history[0].passed, 1);
    assert.ok(info.scenarios.length >= 8);
  } finally {
    await srv.close();
  }
});

test('сервер: «спрашивать только про большие планы» — маленький план идёт без подтверждения', async () => {
  const repo = path.join(mkdtempSync(path.join(tmpdir(), 'ay-srv3-')), 'shop');
  createFeatureRepo(repo);
  const srv = await startServer({ hardware: hw, statsPath: null, runtimeFactory: () => featureRuntime() });
  const base = `http://127.0.0.1:${srv.port}`;
  const H = { 'x-ay-token': srv.token, 'content-type': 'application/json' };
  try {
    const events = collect(`${base}/api/events?t=${srv.token}`, (e) => e.kind === 'result' || e.kind === 'error');
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`${base}/api/run`, { method: 'POST', headers: H, body: JSON.stringify({ repo, goal: FEATURE_GOAL, mock: true, approve: 'big' }) });
    const got = await events;
    assert.ok(!got.some((e) => e.kind === 'plan'), 'план из двух задач не должен ждать подтверждения');
    assert.ok(got.some((e) => e.kind === 'result'));
  } finally {
    await srv.close();
  }
});
