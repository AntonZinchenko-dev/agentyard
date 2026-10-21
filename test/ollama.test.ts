// Адаптер Ollama против поддельного сервера: проверяем форму запросов и разбор ответов.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OllamaRuntime } from '../src/runtime/ollama.ts';

test('Ollama: список моделей, загрузка, выгрузка и чат с инструментами', async () => {
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      seen.push({ path: req.url ?? '', body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen3.6:latest', size: 23 * 1024 ** 3 }] }));
      if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [{ name: 'qwen3.6:latest' }] }));
      if (req.url === '/api/generate') return res.end(JSON.stringify({ done: true }));
      if (req.url === '/api/chat') {
        return res.end(
          JSON.stringify({
            message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.js' } } }] },
            prompt_eval_count: 1200,
            prompt_eval_duration: 400e6,
            eval_count: 50,
            eval_duration: 1e9,
          }),
        );
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const o = new OllamaRuntime(`http://127.0.0.1:${port}`);

  try {
    assert.deepEqual((await o.listInstalled()).map((m) => [m.tag, Math.round(m.sizeGb)]), [['qwen3.6:latest', 23]]);
    assert.deepEqual(await o.loaded(), ['qwen3.6:latest']);

    await o.load('qwen3.6:latest', 16384);
    const load = seen.at(-1)!;
    assert.equal(load.path, '/api/generate');
    assert.deepEqual(load.body.options, { num_ctx: 16384 });

    o.unloadWaitMs = 300; // поддельный сервер всегда говорит, что модель загружена
    await o.unload('qwen3.6:latest');
    assert.equal(seen.filter((x) => x.path === '/api/generate').at(-1)!.body.keep_alive, 0);
    assert.equal(seen.at(-1)!.path, '/api/ps', 'после выгрузки ждём, пока модель уйдёт из /api/ps');

    const r = await o.chat({
      model: 'qwen3.6:latest',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read_file', description: '', parameters: {} } }],
      temperature: 0.1,
      numCtx: 8192,
    });
    const chat = seen.at(-1)!;
    assert.equal(chat.body.stream, true, 'ответ потоком — медленную модель не обрываем, пока она пишет');
    assert.deepEqual(chat.body.options, { temperature: 0.1, num_ctx: 8192 });
    assert.equal(r.message.tool_calls?.[0]?.function.name, 'read_file');
    assert.equal(r.promptTokens, 1200);
    assert.equal(Math.round(r.genMs), 1000);
  } finally {
    server.close();
  }
});

test('Ollama: gpt-oss вернул пустой ответ по схеме — повтор без схемы, JSON берётся из текста', async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      bodies.push(body);
      res.setHeader('content-type', 'application/json');
      const withFormat = 'format' in body;
      res.end(JSON.stringify({ message: { role: 'assistant', content: withFormat ? '' : '{"verdict":"approve","reasons":[]}', thinking: 'думаю…' }, done_reason: 'stop', eval_count: 10 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const o = new OllamaRuntime(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  try {
    const r = await o.chat({ model: 'gpt-oss:20b', messages: [{ role: 'user', content: 'x' }], format: { type: 'object' }, temperature: 0, numCtx: 4096 });
    assert.equal(r.message.content, '{"verdict":"approve","reasons":[]}');
    assert.equal(bodies.length, 2);
    assert.ok('format' in bodies[0]! && !('format' in bodies[1]!));
    assert.equal(r.outputTokens, 20);
  } finally {
    server.close();
  }
});

test('Ollama: ответ потоком — медленная, но живая модель не обрывается; замолчавшая — обрывается', async () => {
  // модель пишет 6 кусочков по 120 мс: всего ~0.7 с — дольше тишины в 400 мс, но паузы короче
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { messages: { content: string }[] };
      res.setHeader('content-type', 'application/x-ndjson');
      if (body.messages[0]!.content === 'молчи') {
        res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'нач' } })}\n`);
        return; // и замолкаем навсегда
      }
      const parts = [{ thinking: 'хм' }, { thinking: 'ну' }, { content: '{"a"' }, { content: ':1}' }, { content: '' }];
      let i = 0;
      const tick = setInterval(() => {
        if (i < parts.length) res.write(`${JSON.stringify({ message: { role: 'assistant', content: '', ...parts[i] } })}\n`);
        else {
          res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 4, prompt_eval_count: 9 })}\n`);
          clearInterval(tick);
        }
        i++;
      }, 120);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const o = new OllamaRuntime(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  o.requestTimeoutMs = 400;
  try {
    const progress: string[] = [];
    const r = await o.chat({ model: 'm', messages: [{ role: 'user', content: 'пиши' }], temperature: 0, numCtx: 4096, onProgress: (p) => progress.push(p.phase) });
    assert.equal(r.message.content, '{"a":1}');
    assert.equal(r.message.thinking, 'хмну');
    assert.equal(r.outputTokens, 4);
    assert.ok(progress.includes('answer'), progress.join(','));
    await assert.rejects(o.chat({ model: 'm', messages: [{ role: 'user', content: 'молчи' }], temperature: 0, numCtx: 4096 }), /замолчала/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('Ollama: «error parsing tool call» у gpt-oss — ответ спасается; «Стоп» обрывает запрос', async () => {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as { messages: { content: string }[] }) : { messages: [] };
      if (body.messages[0]?.content === 'hang') return; // молчит, пока не оборвут
      res.setHeader('content-type', 'application/x-ndjson');
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: false })}\n`);
      res.end(`${JSON.stringify({ error: `error parsing tool call: raw='{"patches":[{"file":"a.tsx","search":"x","replace":"y"}]', err=unexpected end of JSON input` })}\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const o = new OllamaRuntime(`http://127.0.0.1:${port}`);
  try {
    const r = await o.chat({ model: 'gpt-oss:20b', messages: [{ role: 'user', content: 'hi' }], temperature: 0.1, numCtx: 8192 });
    assert.deepEqual(JSON.parse(r.message.content), { patches: [{ file: 'a.tsx', search: 'x', replace: 'y' }] });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const t0 = Date.now();
    await assert.rejects(o.chat({ model: 'gpt-oss:20b', messages: [{ role: 'user', content: 'hang' }], temperature: 0.1, numCtx: 8192, signal: ctrl.signal }), /остановлен человеком/);
    assert.ok(Date.now() - t0 < 3000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
