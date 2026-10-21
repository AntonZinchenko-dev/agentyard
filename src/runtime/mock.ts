// Учебный рантайм без модели: ответы задаются сценарием.
// Нужен для тестов и чтобы проверить конвейер на машине без Ollama.

import type { ChatMessage, ChatRequest, ChatResponse, InstalledModel, Runtime } from './types.ts';

export type Script = (req: ChatRequest, call: number) => ChatMessage;

export class MockRuntime implements Runtime {
  readonly name = 'mock';
  private current: string | null = null;
  swaps = 0;
  calls: ChatRequest[] = [];
  private installed: InstalledModel[];
  private script: Script;

  constructor(installed: InstalledModel[], script: Script) {
    this.installed = installed;
    this.script = script;
  }

  async listInstalled(): Promise<InstalledModel[]> {
    return this.installed;
  }

  async loaded(): Promise<string[]> {
    return this.current ? [this.current] : [];
  }

  async load(tag: string, _numCtx?: number, _opts?: { cpuOnly?: boolean }): Promise<number> {
    if (this.current !== tag) {
      this.swaps += 1;
      this.current = tag;
    }
    return 5;
  }

  async unload(tag: string): Promise<void> {
    if (this.current === tag) this.current = null;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (this.current !== req.model) await this.load(req.model);
    this.calls.push(req);
    const message = this.script(req, this.calls.length);
    // учебная модель «пишет» с задержкой (для показа живой строки в окне); в тестах — мгновенно
    const delay = Number(process.env.AGENTYARD_MOCK_DELAY_MS ?? 0);
    if (req.onProgress) {
      const steps = delay ? 4 : 1;
      for (let i = 1; i <= steps; i++) {
        if (delay) await new Promise((r) => setTimeout(r, delay / steps));
        req.onProgress({ phase: i < steps / 2 ? 'thinking' : 'answer', tokens: 50 * i, tps: 42, seconds: (delay / steps) * i / 1000 });
      }
    }
    return { message, promptTokens: 1000, outputTokens: 200, promptMs: 100, genMs: 1000 };
  }
}

/** Помощник для сценариев: ответ моделью-вызовом инструмента. */
export function toolCall(name: string, args: Record<string, unknown>): ChatMessage {
  return { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] };
}
