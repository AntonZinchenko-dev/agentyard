// Обучение на ходу: успехи моделей по ролям и скорость на этом железе.
// Хранится в JSON-файле (на этапе 1 переедет в SQLite).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { STATS } from './config.ts';
import type { CatalogModel, Role, TaskSize } from './types.ts';

interface Counter { s: number; n: number }
interface Speed {
  genTokPerSec: number;
  prefillTokPerSec: number;
  swapSec: number;
}
interface RoleShape { steps: number; outTokens: number; promptTokens: number }

interface StatsData {
  success: Record<string, Counter>;
  speed: Record<string, Speed>;
  roleShape: Record<string, RoleShape>;
}

const DEFAULT_SPEED: Speed = { genTokPerSec: 20, prefillTokPerSec: 300, swapSec: 15 };
const DEFAULT_SHAPE: RoleShape = { steps: 6, outTokens: 400, promptTokens: 4000 };

export const DEFAULT_STATS_FILE = path.join(os.homedir(), '.agentyard', 'stats.json');

export class Stats {
  private data: StatsData;
  private file: string | null;

  constructor(file: string | null = DEFAULT_STATS_FILE) {
    this.file = file;
    this.data = { success: {}, speed: {}, roleShape: {} };
    if (file && existsSync(file)) {
      try {
        this.data = { ...this.data, ...JSON.parse(readFileSync(file, 'utf8')) };
      } catch {
        // повреждённый файл — начинаем с нуля
      }
    }
  }

  /**
   * Вероятность успеха с первой попытки:
   * p = (успехи + k·p0) / (попытки + k), где p0 — оценка каталога.
   */
  successRate(model: CatalogModel, role: Role, size: TaskSize): number {
    const prior = model.roles[role] ?? 0.4;
    const c = this.data.success[key(model.id, role, size)] ?? { s: 0, n: 0 };
    const k = STATS.priorWeight;
    return (c.s + k * prior) / (c.n + k);
  }

  recordOutcome(modelId: string, role: Role, size: TaskSize, firstTry: boolean): void {
    const k = key(modelId, role, size);
    const c = this.data.success[k] ?? { s: 0, n: 0 };
    // окно: при переполнении сжимаем счётчики пропорционально — новые исходы весят больше старых
    const w = STATS.successWindow;
    if (c.n >= w) {
      c.s = (c.s * (w - 1)) / c.n;
      c.n = w - 1;
    }
    c.n += 1;
    if (firstTry) c.s += 1;
    this.data.success[k] = c;
  }

  speed(modelId: string): Speed {
    return this.data.speed[modelId] ?? { ...DEFAULT_SPEED };
  }

  recordSpeed(modelId: string, sample: Partial<Speed>): void {
    const cur = this.speed(modelId);
    const a = STATS.emaAlpha;
    const next = { ...cur };
    for (const f of ['genTokPerSec', 'prefillTokPerSec', 'swapSec'] as const) {
      const v = sample[f];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        // скользящее среднее: новый замер весит 20%
        next[f] = this.data.speed[modelId] ? cur[f] * (1 - a) + v * a : v;
      }
    }
    this.data.speed[modelId] = next;
  }

  roleShape(role: Role): RoleShape {
    return this.data.roleShape[role] ?? { ...DEFAULT_SHAPE };
  }

  recordShape(role: Role, sample: RoleShape): void {
    const cur = this.data.roleShape[role];
    const a = STATS.emaAlpha;
    this.data.roleShape[role] = cur
      ? {
          steps: cur.steps * (1 - a) + sample.steps * a,
          outTokens: cur.outTokens * (1 - a) + sample.outTokens * a,
          promptTokens: cur.promptTokens * (1 - a) + sample.promptTokens * a,
        }
      : sample;
  }

  /** Ожидаемое время работы модели над задачей роли, секунд (без смены модели). */
  expectedSeconds(modelId: string, role: Role): number {
    const sp = this.speed(modelId);
    const sh = this.roleShape(role);
    // первое чтение запроса + каждый шаг: дочитать ответ инструмента и написать свой ответ
    const prefill = sh.promptTokens / sp.prefillTokPerSec;
    const perStep = sh.outTokens / sp.genTokPerSec + 500 / sp.prefillTokPerSec;
    return prefill + sh.steps * perStep;
  }

  swapSeconds(modelId: string): number {
    return this.speed(modelId).swapSec;
  }

  save(): void {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

function key(model: string, role: Role, size: TaskSize): string {
  return `${model}|${role}|${size}`;
}
