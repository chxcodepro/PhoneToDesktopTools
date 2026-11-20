// Agent 循环：模型 ↔ 电脑工具（MCP）。不依赖 React Native，可在 Node 中测试。
//
// 流程：调用模型 → 有工具调用就经 USB 让电脑执行 → 把结果交回模型 → 直到模型给出最终回答。
// 截图：模型支持图片时作为图片发给模型（只保留最近一张）；不支持时改用文字识别结果（describeImage）。

import type { ToolContent, ToolInfo, ToolResult } from '../protocol/types';
import { chat, type ChatMessage, type ContentPart, type FetchLike, type LlmConfig, type ToolSpec } from './llm';

export interface AgentTools {
  list(): ToolInfo[];
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
}

export interface ComputerInfo {
  host: string;
  os: string;
}

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_start'; id: string; name: string; args: Record<string, unknown>; summary: string }
  | {
      type: 'tool_end';
      id: string;
      name: string;
      isError: boolean;
      summary: string;
      image?: { data: string; mimeType: string };
    }
  | { type: 'notice'; text: string };

export interface AgentOptions {
  llm: LlmConfig;
  fetch: FetchLike;
  supportsVision: boolean;
  supportsTools: boolean;
  /** 电脑未连接时为 null */
  tools: AgentTools | null;
  computer?: ComputerInfo | null;
  signal?: AbortSignal;
  /** 最多执行多少轮工具调用，默认 40 */
  maxSteps?: number;
  /** 模型不支持图片时，把截图转成文字（如手机端 OCR）。返回 null 表示无法识别 */
  describeImage?: (data: string, mimeType: string) => Promise<string | null>;
  onEvent?: (e: AgentEvent) => void;
}

const OLD_IMAGE_TEXT = '[较早的截图已省略]';

function osName(os?: string): string {
  if (os === 'windows') return 'Windows';
  if (os === 'linux') return 'Linux（银河麒麟等）';
  return os || '未知系统';
}

export function buildSystemPrompt(opts: Pick<AgentOptions, 'computer' | 'supportsVision' | 'tools' | 'supportsTools'>): string {
  const lines: string[] = [];
  const connected = !!opts.tools && opts.supportsTools;
  if (connected) {
    const c = opts.computer;
    lines.push(
      `你是运行在用户手机上的 AI 助手，通过 USB 数据线连接并操作用户的电脑${c ? `（${c.host}，${osName(c.os)}）` : ''}。`,
      '工作方式：',
      '- 直接使用工具完成任务，不要只给建议。每一步只做必要的操作，根据结果再决定下一步。',
      '- 不了解电脑环境时先调用 sys_info（可获得桌面路径、显示器等信息）。',
      '- 文件：使用绝对路径；修改已有文件优先用 fs_edit；fs_delete 会把文件移到回收站。',
      opts.computer?.os === 'linux'
        ? '- 命令：使用 bash 语法。需要 sudo 的命令无法自动输入密码，请让用户在电脑上自己执行。'
        : '- 命令：使用 cmd 语法（Win7 自带 PowerShell 2.0，功能有限）。需要管理员权限的操作请告诉用户。',
    );
    if (opts.supportsVision) {
      lines.push(
        '- 操作界面：先 screen_capture 查看屏幕，按返回的 scale 和偏移把截图坐标换算成屏幕坐标，再用 input_mouse / input_keyboard 操作；操作后再截图确认结果。',
      );
    } else {
      lines.push(
        '- 当前模型看不到图片：优先用命令和文件工具完成任务。必须操作界面时，截图会以文字识别结果（文字及其坐标）提供给你。',
      );
    }
    lines.push(
      '- 删除或覆盖重要文件、结束进程、关机重启等不可逆操作前，先用一句话说明你要做什么。',
      '- 工具返回「没有权限」时，告诉用户需要在手机「设置 → 电脑权限」里开启哪一项，不要反复重试。',
    );
  } else {
    lines.push(
      '你是运行在用户手机上的 AI 助手，可以通过 USB 数据线操作用户的电脑。',
      opts.tools
        ? '当前模型不支持工具调用，无法操作电脑，只能回答问题。'
        : '电脑当前未连接，无法操作电脑。需要操作电脑时，请提醒用户用数据线连接电脑并允许 USB 调试。',
    );
  }
  lines.push('用简体中文回答，简洁明了。任务完成后简要说明结果。');
  return lines.join('\n');
}

export function toToolSpecs(tools: ToolInfo[]): ToolSpec[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    },
  }));
}

/** 给界面显示的参数摘要 */
export function summarizeArgs(name: string, args: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));
  switch (name) {
    case 'shell_exec':
      return s(args.command);
    case 'input_mouse': {
      const pos = args.x !== undefined ? ` (${args.x}, ${args.y})` : '';
      return `${s(args.action)}${pos}`;
    }
    case 'input_keyboard':
      return args.action === 'key' ? s(args.keys) : `输入「${s(args.text).slice(0, 40)}」`;
    case 'screen_capture':
      return `显示器 ${args.display ?? 0}`;
    case 'sys_info':
      return '系统信息';
    default:
      if (typeof args.path === 'string') return args.path;
      return Object.values(args).map(s).join(' ').slice(0, 80);
  }
}

/** 给界面显示的结果摘要 */
function summarizeResult(name: string, text: string): string {
  if (name === 'sys_info') {
    try {
      const j = JSON.parse(text);
      return [j.hostname, j.os_version].filter(Boolean).join(' · ') || firstLine(text);
    } catch {
      // 不是 JSON 时按普通文字处理
    }
  }
  return firstLine(text);
}

function firstLine(text: string, max = 160): string {
  const t = text.trim().split('\n').find((l) => l.trim()) ?? '';
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** 把较早消息里的图片替换为文字，只保留最近 keep 张 */
export function pruneImages(messages: ChatMessage[], keep = 1): ChatMessage[] {
  let seen = 0;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (!Array.isArray(m.content)) continue;
    if (!m.content.some((p) => p.type === 'image_url')) continue;
    if (seen < keep) {
      seen++;
      continue;
    }
    out[i] = {
      ...m,
      content: m.content.map((p): ContentPart => (p.type === 'image_url' ? { type: 'text', text: OLD_IMAGE_TEXT } : p)),
    };
  }
  return out;
}

class AbortedError extends Error {
  constructor() {
    super('已停止');
    this.name = 'AbortError';
  }
}

/**
 * 运行 Agent。history 为完整对话（含刚发出的用户消息，不含系统提示）。
 * 返回本次新增的消息（助手消息、工具结果、截图消息），即使中途停止或出错，返回的消息也保持合法顺序。
 */
export async function runAgent(history: ChatMessage[], opts: AgentOptions): Promise<{ added: ChatMessage[]; error?: Error }> {
  const added: ChatMessage[] = [];
  const emit = (e: AgentEvent) => opts.onEvent?.(e);
  const maxSteps = opts.maxSteps ?? 40;
  const useTools = !!opts.tools && opts.supportsTools;
  const tools = useTools ? toToolSpecs(opts.tools!.list()) : undefined;
  const system: ChatMessage = { role: 'system', content: buildSystemPrompt(opts) };

  try {
    for (let step = 0; ; step++) {
      if (opts.signal?.aborted) throw new AbortedError();
      if (step >= maxSteps) {
        emit({ type: 'notice', text: `已连续执行 ${maxSteps} 步，先停下来。可以回复「继续」让我接着做。` });
        break;
      }
      const wire = [system, ...pruneImages([...history, ...added])];
      const { message } = await chat(
        opts.llm,
        wire,
        opts.fetch,
        {
          onText: (delta) => emit({ type: 'text', delta }),
          onReasoning: (delta) => emit({ type: 'reasoning', delta }),
        },
        { tools, signal: opts.signal },
      );
      added.push(message);
      const calls = message.tool_calls ?? [];
      if (!calls.length) break;

      // 依次执行工具（电脑上的操作有先后顺序，不并发）
      const images: { data: string; mimeType: string; tool: string }[] = [];
      for (const call of calls) {
        const name = call.function.name;
        let args: Record<string, unknown> = {};
        let parseError: string | null = null;
        try {
          const parsed = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          args = parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
          parseError = '参数不是合法的 JSON，请重新生成参数';
        }
        emit({ type: 'tool_start', id: call.id, name, args, summary: summarizeArgs(name, args) });

        if (opts.signal?.aborted) {
          added.push({ role: 'tool', tool_call_id: call.id, content: '用户已停止' });
          emit({ type: 'tool_end', id: call.id, name, isError: true, summary: '已停止' });
          continue;
        }
        if (parseError || !opts.tools) {
          const text = parseError ?? '电脑未连接';
          added.push({ role: 'tool', tool_call_id: call.id, content: text });
          emit({ type: 'tool_end', id: call.id, name, isError: true, summary: text });
          continue;
        }

        let result: ToolResult;
        try {
          result = await opts.tools.call(name, args, opts.signal);
        } catch (e) {
          result = { content: [{ type: 'text', text: `调用失败：${(e as Error).message}` }], isError: true };
        }
        const texts = result.content.filter((c): c is Extract<ToolContent, { type: 'text' }> => c.type === 'text').map((c) => c.text);
        const imgs = result.content.filter((c): c is Extract<ToolContent, { type: 'image' }> => c.type === 'image');
        let text = texts.join('\n');

        for (const img of imgs) {
          if (opts.supportsVision) {
            images.push({ data: img.data, mimeType: img.mimeType, tool: name });
            text += '\n（截图见下一条消息）';
          } else {
            let described: string | null = null;
            try {
              described = opts.describeImage ? await opts.describeImage(img.data, img.mimeType) : null;
            } catch {
              described = null;
            }
            text += described
              ? `\n截图的文字识别结果（坐标为截图像素）：\n${described}`
              : '\n（当前模型看不到图片，且未能识别截图文字。请改用命令、文件等文字类工具获取信息。）';
          }
        }
        added.push({ role: 'tool', tool_call_id: call.id, content: text || (result.isError ? '失败' : '完成') });
        emit({
          type: 'tool_end',
          id: call.id,
          name,
          isError: !!result.isError,
          summary: summarizeResult(name, texts.join('\n')) || (imgs.length ? '已截图' : '完成'),
          image: imgs[0] ? { data: imgs[0].data, mimeType: imgs[0].mimeType } : undefined,
        });
      }
      if (images.length) {
        added.push({
          role: 'user',
          content: [
            { type: 'text', text: '以下是工具返回的截图：' },
            ...images.map(
              (img): ContentPart => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } }),
            ),
          ],
        });
      }
    }
    return { added };
  } catch (e) {
    // 补齐缺失的工具结果，保证对话历史合法（每个 tool_call 都要有对应的 tool 消息）
    const last = added[added.length - 1];
    if (last?.role === 'assistant' && last.tool_calls?.length) {
      for (const c of last.tool_calls) added.push({ role: 'tool', tool_call_id: c.id, content: '用户已停止' });
    } else {
      const answered = new Set(added.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
      const lastAssistant = [...added].reverse().find((m) => m.role === 'assistant' && m.tool_calls?.length);
      for (const c of lastAssistant?.tool_calls ?? []) {
        if (!answered.has(c.id)) added.push({ role: 'tool', tool_call_id: c.id, content: '用户已停止' });
      }
    }
    const err = e as Error;
    const aborted = err?.name === 'AbortError' || opts.signal?.aborted;
    return { added, error: aborted ? new AbortedError() : err };
  }
}
