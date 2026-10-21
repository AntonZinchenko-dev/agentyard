// Общий интерфейс рантайма. Оркестратор не знает, на чём крутится модель:
// Ollama сейчас, node-llama-cpp потом — меняется только адаптер.

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Рассуждения «думающей» модели (Ollama отдаёт их отдельно от ответа). */
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** JSON-схема ответа (строгая форма). */
  format?: Record<string, unknown>;
  temperature: number;
  numCtx: number;
  /** Режим рассуждений: false — выключить, 'low'…'high' — уровень (для моделей, которые это умеют). */
  think?: boolean | 'low' | 'medium' | 'high';
  /** Предел длины ответа в токенах — чтобы модель не «зависала» на минуты. */
  maxTokens?: number;
  /** Ход генерации (примерно раз в секунду): сколько написано, рассуждения или ответ, скорость. */
  onProgress?: (p: ChatProgress) => void;
  /** Оборвать запрос (кнопка «Стоп»). */
  signal?: AbortSignal;
}

export interface ChatProgress {
  /** prompt — модель читает запрос (первого токена ещё нет), thinking — рассуждает, answer — пишет ответ. */
  phase: 'prompt' | 'thinking' | 'answer';
  /** Сколько токенов написано (рассуждения + ответ). */
  tokens: number;
  /** Токенов в секунду с начала письма. */
  tps: number;
  /** Секунд с начала запроса. */
  seconds: number;
}

export interface ChatResponse {
  message: ChatMessage;
  promptTokens: number;
  outputTokens: number;
  promptMs: number;
  genMs: number;
  /** Ответ оборван по лимиту длины. */
  truncated?: boolean;
}

export interface InstalledModel {
  tag: string;
  sizeGb: number;
}

export interface Runtime {
  readonly name: string;
  listInstalled(): Promise<InstalledModel[]>;
  /** Какие модели сейчас в памяти. */
  loaded(): Promise<string[]>;
  /** Загрузить модель; возвращает время загрузки, мс. */
  /** cpuOnly — грузить без видеокарты (запасной путь, когда CUDA сбоит). */
  load(tag: string, numCtx: number, opts?: { cpuOnly?: boolean }): Promise<number>;
  unload(tag: string): Promise<void>;
  chat(req: ChatRequest): Promise<ChatResponse>;
  pull?(tag: string, onProgress?: (text: string) => void): Promise<void>;
  /** Перезапустить сервер моделей (сбой видеокарты лечится чистым стартом). true — поднялся. */
  restart?(): Promise<boolean>;
}
