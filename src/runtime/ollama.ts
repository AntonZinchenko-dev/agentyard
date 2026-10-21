// Адаптер Ollama: HTTP API на localhost:11434.
// Важно: длину контекста передаём в каждом запросе — по умолчанию Ollama даёт всего 4K.

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ChatProgress, ChatRequest, ChatResponse, InstalledModel, Runtime } from './types.ts';

const KEEP_ALIVE = '30m';

type RawChat = {
  message: ChatResponse['message'];
  done_reason?: string;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
};

export class OllamaRuntime implements Runtime {
  readonly name = 'ollama';
  private base: string;

  constructor(host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434') {
    this.base = host.startsWith('http') ? host.replace(/\/$/, '') : `http://${host}`;
  }

  /**
   * Тишина, после которой запрос считается зависшим: ни одного нового токена за это время.
   * Ответ приходит потоком, поэтому медленная, но живая модель (на процессоре — 10 токенов в секунду) не обрывается.
   */
  requestTimeoutMs = Number(process.env.AGENTYARD_REQUEST_TIMEOUT_MS ?? 300_000);
  /** На процессоре длинный запрос читается минутами до первого токена — ждём дольше. */
  cpuFirstTokenMs = 15 * 60_000;
  /** Потолок одного ответа целиком. */
  maxAnswerMs = Number(process.env.AGENTYARD_MAX_ANSWER_MS ?? 45 * 60_000);

  private async post<T>(pathName: string, body: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${pathName}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = e as Error;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new Error(`Модель не ответила за ${Math.round(timeoutMs / 1000)} с (${pathName}).`);
      }
      throw new Error(`Ollama недоступна (${pathName}): ${err.message}`);
    }
    if (!res.ok) throw new Error(`Ollama ${pathName}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  private async get<T>(pathName: string): Promise<T> {
    const res = await fetch(`${this.base}${pathName}`);
    if (!res.ok) throw new Error(`Ollama ${pathName}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async ping(): Promise<boolean> {
    try {
      await this.get('/api/version');
      return true;
    } catch {
      return false;
    }
  }

  async listInstalled(): Promise<InstalledModel[]> {
    const r = await this.get<{ models: { name: string; size: number }[] }>('/api/tags');
    return r.models.map((m) => ({ tag: m.name, sizeGb: m.size / 1024 ** 3 }));
  }

  /** Сколько ждать фактической выгрузки модели из видеопамяти. */
  unloadWaitMs = 15_000;

  async loaded(): Promise<string[]> {
    const r = await this.get<{ models: { name: string }[] }>('/api/ps');
    return r.models.map((m) => m.name);
  }

  /** Модели, которые после сбоя видеокарты работают на процессоре: те же опции нужны и в chat, иначе Ollama перезагрузит модель на GPU. */
  readonly cpuOnly = new Set<string>();

  async load(tag: string, numCtx: number, opts: { cpuOnly?: boolean } = {}): Promise<number> {
    const started = Date.now();
    if (opts.cpuOnly) this.cpuOnly.add(tag);
    else this.cpuOnly.delete(tag);
    const options: Record<string, unknown> = { num_ctx: numCtx };
    if (opts.cpuOnly) options.num_gpu = 0;
    // пустой запрос к /api/generate загружает модель в память
    await this.post('/api/generate', { model: tag, prompt: '', keep_alive: KEEP_ALIVE, options }, 10 * 60_000);
    return Date.now() - started;
  }

  async unload(tag: string): Promise<void> {
    await this.post('/api/generate', { model: tag, prompt: '', keep_alive: 0 });
    // Ollama отвечает раньше, чем видеопамять реально освобождена; если сразу грузить следующую модель,
    // драйвер может не найти памяти и процесс модели падает (на Windows — 0xc0000409 / CUDA error). Ждём выгрузки.
    const until = Date.now() + this.unloadWaitMs;
    while (Date.now() < until) {
      const still = await this.loaded().catch(() => []);
      if (!still.some((n) => n === tag || n.split(':')[0] === tag.split(':')[0])) return;
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const options: Record<string, unknown> = { temperature: req.temperature, num_ctx: req.numCtx };
    if (req.maxTokens) options.num_predict = req.maxTokens;
    if (this.cpuOnly.has(req.model)) options.num_gpu = 0;
    const body: Record<string, unknown> = {
      model: req.model,
      // рассуждения прошлых шагов обратно не отправляем — экономим контекст
      messages: req.messages.map(({ thinking: _t, ...m }) => m),
      stream: true,
      keep_alive: KEEP_ALIVE,
      options,
    };
    if (req.tools?.length) body.tools = req.tools;
    if (req.format) body.format = req.format;
    if (req.think !== undefined && !this.noThink.has(req.model)) body.think = req.think;

    const cpu = this.cpuOnly.has(req.model);
    const send = (b: Record<string, unknown>) => this.streamChat(b, req.onProgress, cpu, req.signal);
    let r: RawChat;
    try {
      r = await send(body);
    } catch (e) {
      // модель не умеет режим рассуждений — запоминаем и повторяем без него
      if ('think' in body && /think/i.test((e as Error).message)) {
        this.noThink.add(req.model);
        delete body.think;
        r = await send(body);
      } else {
        throw e;
      }
    }

    // gpt-oss иногда при ответе «по схеме» тратит всё на рассуждения и возвращает пустой ответ.
    // Повторяем тот же запрос без схемы: в запросе и так сказано «верни JSON», а JSON достанем из текста.
    if (req.format && !(r.message?.content ?? '').trim() && !r.message?.tool_calls?.length && r.done_reason !== 'length') {
      const { format: _f, ...plain } = body;
      const r2 = await send(plain);
      if ((r2.message?.content ?? '').trim()) {
        r2.prompt_eval_count = (r2.prompt_eval_count ?? 0) + (r.prompt_eval_count ?? 0);
        r2.eval_count = (r2.eval_count ?? 0) + (r.eval_count ?? 0);
        r = r2;
      }
    }

    return {
      message: { role: 'assistant', content: r.message?.content ?? '', thinking: r.message?.thinking || undefined, tool_calls: r.message?.tool_calls },
      promptTokens: r.prompt_eval_count ?? 0,
      outputTokens: r.eval_count ?? 0,
      promptMs: (r.prompt_eval_duration ?? 0) / 1e6,
      genMs: (r.eval_duration ?? 0) / 1e6,
      truncated: r.done_reason === 'length',
    };
  }

  /** Модели, которые отказались от параметра think. */
  private noThink = new Set<string>();

  /**
   * Перезапуск Ollama на этом компьютере (Windows): закрыть сервер и программу в трее, запустить заново, дождаться ответа.
   * Сбой CUDA «shared object initialization failed» живёт в процессе Ollama — чистый старт его сбрасывает.
   * Только для локального сервера; AGENTYARD_NO_OLLAMA_RESTART=1 — запретить.
   */
  async restart(): Promise<boolean> {
    if (process.env.AGENTYARD_NO_OLLAMA_RESTART === '1' || process.platform !== 'win32') return false;
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(this.base)) return false;
    const kill = (image: string) => new Promise<void>((r) => execFile('taskkill', ['/F', '/T', '/IM', image], { windowsHide: true }, () => r()));
    await kill('ollama app.exe');
    await kill('ollama.exe');
    await kill('llama-server.exe');
    await new Promise((r) => setTimeout(r, 2000));
    const dir = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama');
    const app = path.join(dir, 'ollama app.exe');
    const cli = path.join(dir, 'ollama.exe');
    const start = (file: string, args: string[]) => {
      const p = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
      p.on('error', () => undefined);
      p.unref();
    };
    if (existsSync(app)) start(app, []);
    else start(existsSync(cli) ? cli : 'ollama', ['serve']);
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await this.ping()) {
        this.cpuOnly.clear();
        return true;
      }
    }
    return false;
  }

  /**
   * /api/chat потоком: кусочки ответа складываем сами. Обрываем только тишину (зависание), а не долгую работу.
   * Сервер, который отвечает одним JSON целиком (старые версии, тесты), тоже понимаем.
   */
  private async streamChat(body: Record<string, unknown>, onProgress: ((p: ChatProgress) => void) | undefined, cpu: boolean, signal?: AbortSignal): Promise<RawChat> {
    const started = Date.now();
    const ctrl = new AbortController();
    let why = '';
    // «Стоп» человека обрывает запрос сразу, а не ждёт, пока модель допишет
    const onStop = () => {
      why = 'Прогон остановлен человеком — запрос к модели оборван.';
      ctrl.abort();
    };
    if (signal?.aborted) throw new Error('Прогон остановлен человеком — запрос к модели оборван.');
    signal?.addEventListener('abort', onStop, { once: true });
    let timer: NodeJS.Timeout | null = null;
    const arm = (ms: number, reason: string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        why = reason;
        ctrl.abort();
      }, ms);
    };
    const silence = this.requestTimeoutMs;
    const first = cpu ? Math.max(silence, this.cpuFirstTokenMs) : silence;
    arm(first, `Модель не ответила за ${Math.round(first / 1000)} с (/api/chat).`);
    const cap = setTimeout(() => {
      why = `Модель пишет ответ дольше ${Math.round(this.maxAnswerMs / 60_000)} мин — прервал (/api/chat).`;
      ctrl.abort();
    }, this.maxAnswerMs);
    const tick = setInterval(() => report(), 1000);
    let tokens = 0;
    let firstTokenAt = 0;
    let phase: ChatProgress['phase'] = 'prompt';
    const report = () => {
      if (!onProgress) return;
      const now = Date.now();
      const writing = firstTokenAt ? (now - firstTokenAt) / 1000 : 0;
      try {
        onProgress({ phase, tokens, tps: writing > 0.5 ? tokens / writing : 0, seconds: (now - started) / 1000 });
      } catch {
        /* окно не роняет запрос */
      }
    };
    const out: RawChat = { message: { role: 'assistant', content: '' } };
    let thinking = '';
    const calls: NonNullable<ChatResponse['message']['tool_calls']> = [];
    const take = (ev: Record<string, unknown>) => {
      if (typeof ev.error === 'string') {
        // gpt-oss: Ollama не разобрала «вызов инструмента», хотя это наш JSON-ответ, часто просто без закрывающей скобки.
        // Достаём сырой текст и чиним скобки — иначе попытка пропадает (прогон 20261020112744: 3 из 5 попыток задачи)
        const raw = /error parsing tool call: raw='([\s\S]*)', err=/.exec(ev.error)?.[1];
        const fixed = raw ? repairJson(raw) : null;
        if (fixed) {
          out.message.content += fixed;
          phase = 'answer';
          return;
        }
        throw new Error(`Ollama /api/chat: ${ev.error}`);
      }
      const m = ev.message as { content?: string; thinking?: string; tool_calls?: typeof calls } | undefined;
      if (m) {
        if (m.thinking) {
          thinking += m.thinking;
          phase = 'thinking';
          tokens += 1;
        }
        if (m.content) {
          out.message.content += m.content;
          phase = 'answer';
          tokens += 1;
        }
        if (m.tool_calls?.length) {
          calls.push(...m.tool_calls);
          phase = 'answer';
        }
        if ((m.thinking || m.content || m.tool_calls) && !firstTokenAt) firstTokenAt = Date.now();
      }
      for (const k of ['done_reason', 'prompt_eval_count', 'prompt_eval_duration', 'eval_count', 'eval_duration'] as const) {
        if (ev[k] !== undefined) (out as Record<string, unknown>)[k] = ev[k];
      }
    };
    try {
      let res: Response;
      try {
        res = await fetch(`${this.base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
      } catch (e) {
        if (why) throw new Error(why);
        throw new Error(`Ollama недоступна (/api/chat): ${(e as Error).message}`);
      }
      if (!res.ok) throw new Error(`Ollama /api/chat: ${res.status} ${await res.text()}`);
      const decoder = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          arm(silence, `Модель замолчала больше чем на ${Math.round(silence / 1000)} с (/api/chat).`);
          buf += decoder.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) take(JSON.parse(line) as Record<string, unknown>);
          }
        }
      } catch (e) {
        if (why) throw new Error(why);
        throw e;
      }
      if (buf.trim()) take(JSON.parse(buf) as Record<string, unknown>);
    } finally {
      if (timer) clearTimeout(timer);
      clearTimeout(cap);
      clearInterval(tick);
      signal?.removeEventListener('abort', onStop);
    }
    if (thinking) out.message.thinking = thinking;
    if (calls.length) out.message.tool_calls = calls;
    report();
    return out;
  }

  async pull(tag: string, onProgress?: (text: string) => void): Promise<void> {
    const res = await fetch(`${this.base}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: tag, stream: true }),
    });
    if (!res.ok || !res.body) throw new Error(`Ollama pull ${tag}: ${res.status}`);
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
        if (ev.error) throw new Error(ev.error);
        const pct = ev.total ? ` ${Math.round(((ev.completed ?? 0) / ev.total) * 100)}%` : '';
        onProgress?.(`${ev.status ?? ''}${pct}`);
      }
    }
  }
}

/** Починить обрезанный JSON: закрыть строку и скобки. null — если и после этого не разбирается. */
export function repairJson(raw: string): string | null {
  const text = raw.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  try {
    JSON.parse(text);
    return text;
  } catch {
    /* чиним */
  }
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of text) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let fixed = text;
  if (inStr) fixed += '"';
  fixed = fixed.replace(/,\s*$/, '');
  fixed += stack.reverse().join('');
  try {
    JSON.parse(fixed);
    return fixed;
  } catch {
    return null;
  }
}
