// Замер железа: видеокарта, память, процессор → тир.
// Без внешних библиотек: os + nvidia-smi (если есть).

import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Hardware, Tier } from './types.ts';

const run = promisify(execFile);
const GB = 1024 ** 3;

interface GpuInfo { name: string; totalGb: number; freeGb: number }

/** NVIDIA: точные цифры видеопамяти через nvidia-smi. */
async function probeNvidia(): Promise<GpuInfo | null> {
  try {
    const { stdout } = await run('nvidia-smi', [
      '--query-gpu=name,memory.total,memory.free',
      '--format=csv,noheader,nounits',
    ], { timeout: 5000, windowsHide: true });
    const first = stdout.trim().split(/\r?\n/)[0];
    if (!first) return null;
    const [name, total, free] = first.split(',').map((s) => s.trim());
    return { name: name ?? 'NVIDIA GPU', totalGb: Number(total) / 1024, freeGb: Number(free) / 1024 };
  } catch {
    return null;
  }
}

/** Apple Silicon: память общая, видеокарте доступна большая её часть. */
function isAppleSilicon(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64';
}

export function tierFor(vramGb: number, ramGb: number, unified: boolean): Tier {
  // На Mac считаем, что модели доступно около 70% общей памяти.
  const effective = unified ? ramGb * 0.7 : vramGb;
  if (effective >= 60) return 'T4';
  if (effective >= 22) return 'T3';
  if (effective >= 11) return 'T2';
  if (effective >= 5.5) return 'T1';
  return 'T0';
}

export async function probeHardware(): Promise<Hardware> {
  const ramTotalGb = os.totalmem() / GB;
  const ramFreeGb = os.freemem() / GB;
  const cpuCores = os.cpus().length;
  const unified = isAppleSilicon();
  const gpu = unified ? null : await probeNvidia();

  const vramTotalGb = unified ? ramTotalGb * 0.7 : gpu?.totalGb ?? 0;
  const vramFreeGb = unified ? ramFreeGb * 0.7 : gpu?.freeGb ?? 0;

  return {
    gpuName: unified ? 'Apple Silicon (общая память)' : gpu?.name ?? null,
    vramTotalGb: round(vramTotalGb),
    vramFreeGb: round(vramFreeGb),
    ramTotalGb: round(ramTotalGb),
    ramFreeGb: round(ramFreeGb),
    cpuCores,
    unifiedMemory: unified,
    tier: tierFor(vramTotalGb, ramTotalGb, unified),
  };
}

export const TIER_TEXT: Record<Tier, string> = {
  T0: 'Без видеокарты: модели 4B на процессоре, медленно — годится, чтобы попробовать.',
  T1: '6–8 ГБ видеопамяти: модели 4–9B, задачи режем мельче.',
  T2: '12–16 ГБ: модели 12–20B, комфортно для повседневной работы.',
  T3: '24 ГБ или Mac 32 ГБ: модели 26–35B, лучшее качество на одной видеокарте.',
  T4: '64 ГБ+: модели класса 80B MoE.',
};

function round(x: number): number {
  return Math.round(x * 10) / 10;
}
