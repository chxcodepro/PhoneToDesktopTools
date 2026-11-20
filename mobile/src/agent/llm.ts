// OpenAI 协议（Chat Completions）客户端：流式输出 + 工具调用。
// 不依赖 React Native，fetch 可注入（App 中使用 expo/fetch 以支持流式读取，测试中使用 Node 的 fetch）。

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** DeepSeek 等思考模型返回的思考过程（默认不回传给接口） */
  reasoning_content?: string;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 最小 fetch 接口，兼容 Node fetch 与 expo/fetch */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  body: ReadableStream<Uint8Array> | null;
}>;

export class LlmError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

export interface StreamCallbacks {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
}

export interface ChatResult {
  message: ChatMessage;
  finishReason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function endpoint(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path;
}

function headers(cfg: LlmConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  };
}

/** 检查配置是否已填写（占位符视为未填写） */
export function configProblem(cfg: Partial<LlmConfig>): string | null {
  const unset = (v?: string) => !v || /^<.*>$/.test(v.trim());
  if (unset(cfg.baseUrl)) return '接口地址未填写';
  if (!/^https?:\/\//i.test(cfg.baseUrl!.trim())) return '接口地址需要以 http:// 或 https:// 开头';
  if (unset(cfg.apiKey)) return 'API Key 未填写';
  if (unset(cfg.model)) return '模型未选择';
  return null;
}

async function errorFrom(res: { status: number; text(): Promise<string> }): Promise<LlmError> {
  let detail = '';
  try {
    const raw = await res.text();
    try {
      const j = JSON.parse(raw);
      detail = j?.error?.message ?? j?.message ?? raw;
    } catch {
      detail = raw;
    }
  } catch {
    // 忽略
  }
  const hint: Record<number, string> = {
    401: 'API Key 无效',
    402: '账户余额不足',
    403: '没有权限访问该模型',
    404: '接口地址或模型名错误',
    429: '请求太频繁或额度已用完',
  };
  const prefix = hint[res.status] ?? `请求失败（HTTP ${res.status}）`;
  return new LlmError(res.status, detail ? `${prefix}：${String(detail).slice(0, 300)}` : prefix);
}

/** GET /models 获取可用模型列表 */
export async function listModels(cfg: Omit<LlmConfig, 'model'>, fetchImpl: FetchLike, signal?: AbortSignal): Promise<string[]> {
  const res = await fetchImpl(endpoint(cfg.baseUrl, '/models'), {
    method: 'GET',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw await errorFrom(res);
  const j = JSON.parse(await res.text());
  const data: { id?: string }[] = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
  return data
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string')
    .sort();
}

interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** 把流式片段累积成完整消息 */
class Accumulator {
  text = '';
  reasoning = '';
  calls: { id: string; name: string; args: string }[] = [];
  finishReason: string | null = null;
  usage?: ChatResult['usage'];

  constructor(private cb: StreamCallbacks) {}

  apply(chunk: any): void {
    if (chunk?.usage) this.usage = chunk.usage;
    const choice = chunk?.choices?.[0];
    if (!choice) return;
    const d = choice.delta ?? choice.message ?? {};
    if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
      this.reasoning += d.reasoning_content;
      this.cb.onReasoning?.(d.reasoning_content);
    }
    if (typeof d.content === 'string' && d.content) {
      this.text += d.content;
      this.cb.onText?.(d.content);
    }
    const tcs: ToolCallDelta[] = Array.isArray(d.tool_calls) ? d.tool_calls : [];
    for (let i = 0; i < tcs.length; i++) {
      const tc = tcs[i];
      const idx = typeof tc.index === 'number' ? tc.index : i;
      const slot = (this.calls[idx] ??= { id: '', name: '', args: '' });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
  }

  result(): ChatResult {
    const calls = this.calls.filter(Boolean).map((c, i) => ({
      id: c.id || `call_${Date.now().toString(36)}_${i}`,
      type: 'function' as const,
      function: { name: c.name, arguments: c.args || '{}' },
    }));
    const message: ChatMessage = { role: 'assistant', content: this.text || null };
    if (calls.length) message.tool_calls = calls;
    if (this.reasoning) message.reasoning_content = this.reasoning;
    return { message, finishReason: this.finishReason, usage: this.usage };
  }
}

/** 准备发给接口的消息：默认去掉 reasoning_content（部分接口收到会报 400） */
function wireMessages(messages: ChatMessage[], keepReasoning: boolean): ChatMessage[] {
  return messages.map((m) => {
    if (m.reasoning_content === undefined) return m;
    if (keepReasoning && m.role === 'assistant') return m;
    const { reasoning_content: _r, ...rest } = m;
    return rest;
  });
}

export interface ChatOptions {
  tools?: ToolSpec[];
  signal?: AbortSignal;
  temperature?: number;
}

/**
 * 发起一次流式对话。服务端不支持流式（直接返回 JSON）时也能正常处理。
 * 若接口提示必须回传 reasoning_content（新版思考模型调用工具时），会自动带上重试一次。
 */
export async function chat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  fetchImpl: FetchLike,
  cb: StreamCallbacks = {},
  opts: ChatOptions = {},
): Promise<ChatResult> {
  try {
    return await chatOnce(cfg, messages, fetchImpl, cb, opts, false);
  } catch (e) {
    if (e instanceof LlmError && e.status === 400 && /reasoning_content/i.test(e.message)) {
      return chatOnce(cfg, messages, fetchImpl, cb, opts, true);
    }
    throw e;
  }
}

async function chatOnce(
  cfg: LlmConfig,
  messages: ChatMessage[],
  fetchImpl: FetchLike,
  cb: StreamCallbacks,
  opts: ChatOptions,
  keepReasoning: boolean,
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: wireMessages(messages, keepReasoning),
    stream: true,
  };
  if (opts.tools?.length) body.tools = opts.tools;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;

  const res = await fetchImpl(endpoint(cfg.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) throw await errorFrom(res);

  const acc = new Accumulator(cb);
  if (!res.body) {
    // 不支持流式读取的环境：整体解析
    parseSseText(await res.text(), acc);
    return acc.result();
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let sawSse = false;
  let raw = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (!sawSse) raw += chunk;
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (handleSseLine(line, acc)) sawSse = true;
    }
  }
  buf += decoder.decode();
  if (buf.trim()) {
    if (handleSseLine(buf.trim(), acc)) sawSse = true;
  }
  if (!sawSse) {
    // 服务端忽略了 stream 参数，返回了普通 JSON
    try {
      acc.apply(JSON.parse(raw));
    } catch {
      throw new LlmError(res.status, '无法解析模型返回的数据');
    }
  }
  return acc.result();
}

/** 处理一行 SSE，返回是否为 SSE 数据行 */
function handleSseLine(line: string, acc: Accumulator): boolean {
  if (!line.startsWith('data:')) return false;
  const data = line.slice(5).trim();
  if (!data || data === '[DONE]') return true;
  let j: any;
  try {
    j = JSON.parse(data);
  } catch {
    return true; // 忽略不完整的行
  }
  if (j?.error) {
    throw new LlmError(500, `模型返回错误：${j.error.message ?? JSON.stringify(j.error)}`);
  }
  acc.apply(j);
  return true;
}

function parseSseText(text: string, acc: Accumulator): void {
  let sse = false;
  for (const line of text.split('\n')) {
    if (handleSseLine(line.replace(/\r$/, ''), acc)) sse = true;
  }
  if (!sse) acc.apply(JSON.parse(text));
}
