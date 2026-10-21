// Рассуждения «думающих» моделей: выключаем исполнителям, ограничиваем длину ответа.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OllamaRuntime } from '../src/runtime/ollama.ts';
import { thinkFor } from '../src/agent.ts';

test('think: исполнителям выключено, планировщику разрешено', () => {
  assert.equal(thinkFor('coder', 'toggle'), false);
  assert.equal(thinkFor('reviewer', 'levels'), 'low');
  assert.equal(thinkFor('planner', 'toggle'), true);
  assert.equal(thinkFor('planner', 'levels'), 'medium');
  assert.equal(thinkFor('coder', undefined), undefined, 'модели без рассуждений параметр не отправляем');
});

test('Ollama: передаёт think и num_predict, повторяет без think, если модель его не умеет', async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      if (body.model === 'old' && 'think' in body) {
        res.statusCode = 400;
        return res.end('{"error":"\\"old\\" does not support thinking"}');
      }
      res.end(JSON.stringify({ message: { role: 'assistant', content: '', thinking: 'долго думаю…' }, done_reason: 'length', eval_count: 4096 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const o = new OllamaRuntime(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  try {
    const r = await o.chat({ model: 'qwen', messages: [{ role: 'user', content: 'x' }], temperature: 0, numCtx: 8192, think: false, maxTokens: 4096 });
    assert.equal(bodies[0]!.think, false);
    assert.deepEqual(bodies[0]!.options, { temperature: 0, num_ctx: 8192, num_predict: 4096 });
    assert.equal(r.truncated, true);
    assert.equal(r.message.thinking, 'долго думаю…');

    await o.chat({ model: 'old', messages: [{ role: 'assistant', content: 'a', thinking: 'скрыть' }], temperature: 0, numCtx: 8192, think: false });
    assert.equal(bodies.length, 3, 'повтор без think');
    assert.ok(!('think' in bodies[2]!));
    assert.deepEqual(bodies[2]!.messages, [{ role: 'assistant', content: 'a' }], 'рассуждения не уходят обратно в модель');
    await o.chat({ model: 'old', messages: [], temperature: 0, numCtx: 8192, think: false });
    assert.ok(!('think' in bodies[3]!), 'запомнил, что модель не умеет think');
  } finally {
    server.close();
  }
});

test('Ollama: зависший запрос прерывается по таймауту с понятной ошибкой', async () => {
  const server = http.createServer(() => {
    /* никогда не отвечает */
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const o = new OllamaRuntime(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  o.requestTimeoutMs = 300;
  try {
    await assert.rejects(o.chat({ model: 'm', messages: [], temperature: 0, numCtx: 1024 }), /не ответила за 0 с/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
