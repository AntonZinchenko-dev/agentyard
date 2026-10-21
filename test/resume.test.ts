// Продолжение прерванного прогона: процесс «умер» на середине, новый доделывает остальное, сделанное не переделывается.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createFeatureRepo, featureRuntime, featureScript, FEATURE_GOAL } from '../src/demo.ts';
import { MockRuntime } from '../src/runtime/mock.ts';
import { Pipeline, readRunState } from '../src/pipeline.ts';
import { listRuns } from '../src/server.ts';
import { loadCatalog } from '../src/catalog.ts';
import { Stats } from '../src/stats.ts';
import type { ChatRequest, ChatResponse } from '../src/runtime/types.ts';
import type { Hardware } from '../src/types.ts';

const HW: Hardware = { gpuName: 'test', vramTotalGb: 48, vramFreeGb: 48, ramTotalGb: 64, ramFreeGb: 32, cpuCores: 8, unifiedMemory: false, tier: 'T3' };

/** Кодер «зависает» навсегда — как будто окно закрыли посреди его работы. */
let coderHung = false;
class Hangs extends MockRuntime {
  async chat(req: ChatRequest): Promise<ChatResponse> {
    if ((req.messages[0]?.content ?? '').startsWith('Ты — кодер')) {
      coderHung = true;
      return new Promise<ChatResponse>(() => undefined);
    }
    return super.chat(req);
  }
}

test('прогон оборвался на кодере — «Продолжить» доделывает, тест не пишется заново, результат применяется', async () => {
  const repo = path.join(mkdtempSync(path.join(tmpdir(), 'ay-resume-')), 'shop');
  createFeatureRepo(repo);
  const runDir = path.join(repo, '.agentyard', 'runs', 'r1');
  const base = { repo, goal: FEATURE_GOAL, catalog: loadCatalog(), hardware: HW, stats: new Stats(null), quiet: true, runId: 'r1' };

  void new Pipeline({ ...base, runtime: new Hangs([{ tag: 'qwen3.6:latest', sizeGb: 23 }, { tag: 'gpt-oss:20b', sizeGb: 14 }], featureScript()) }).run();
  // ждём, пока тест сделан и влит, а кодер «завис»
  for (let i = 0; i < 1200; i++) {
    const st = readRunState(runDir);
    // процесс «умер» именно тогда, когда кодер начал работу (рабочая копия уже создана)
    if (coderHung && st?.tasks.find((t) => t.id === 'T1')?.status === 'running') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const st = readRunState(runDir)!;
  assert.equal(st.tasks.find((t) => t.id === 'T1')?.status, 'running');
  assert.equal(listRuns(repo)[0]?.resumable, true);

  let testerCalls = 0;
  const rt = featureRuntime();
  const orig = rt.chat.bind(rt);
  rt.chat = (req) => {
    if ((req.messages[0]?.content ?? '').includes('тестировщик')) testerCalls += 1;
    return orig(req);
  };
  const res = await new Pipeline({ ...base, runtime: rt, resume: true, autoApply: true }).run();
  const journal = readFileSync(path.join(res.runDir, 'journal.txt'), 'utf8');
  assert.deepEqual(res.done.sort(), ['T1', 'T1-test'], journal);
  assert.equal(testerCalls, 0, 'сделанное до сбоя не переделывается');
  assert.match(journal, /Продолжаю прерванный прогон: сделано 1, осталось 1/);
  assert.equal(res.applied?.ok, true, res.applied?.message ?? '');
  assert.ok(existsSync(path.join(repo, 'src/promo.js')));
  // хвосты упавшего процесса убраны: только основная рабочая копия
  assert.equal(execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').length, 1);
  assert.equal(listRuns(repo)[0]?.resumable, false);
  // в отчёте — и то, что было до сбоя
  assert.match(readFileSync(res.reportPath.replace(/html$/, 'md'), 'utf8'), /Тестировщик .* сдал T1-test/);
});
