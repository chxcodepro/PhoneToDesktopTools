// 上下文压缩：把较早的对话交给模型总结成摘要，最近几轮原样保留。
// 只压缩发给模型的历史，界面上的聊天记录不变。

import { SCREENSHOT_MARKER } from './agent';
import { chat, type ChatMessage, type FetchLike, type LlmConfig } from './llm';

export const SUMMARY_PREFIX = '[之前对话的摘要]';

// 摘要的小节参考 DeepSeek Harness 的压缩（compaction-basic）：固定结构、保留原文细节、合并旧摘要
const SYSTEM = [
  '你负责压缩一段「用户让 AI 操作电脑」的对话记录，供 AI 接着工作。',
  '用简体中文输出一份精炼的摘要，按下面的小节和顺序，用简短的要点，不写大段文字；没有内容的小节写「（无）」，不要删掉小节：',
  '## 用户的目标和要求（含偏好、限制、纠正过的地方，关键原话照抄）',
  '## 已完成的操作和结果（执行过的命令、改过的文件和设置、得到的关键数据）',
  '## 出过的错误和解决办法',
  '## 重要信息（文件路径、窗口/程序名、配置值、命令、报错原文等，原样保留）',
  '## 正在做的事',
  '## 下一步（紧接着用户最近的要求要做的一件事）',
  `记录里如果已经有「${'[之前对话的摘要]'}」，那是更早的摘要：保留仍然成立的内容、去掉过时的，和新内容合并成一份，不要原样照抄。`,
  '只输出摘要本身，不要寒暄，不要提到「压缩」，不要编造记录里没有的内容。',
].join('\n');

const TOOL_RESULT_LIMIT = 800;
const ARGS_LIMIT = 300;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…（省略 ${s.length - n} 字）` : s;
}

function textOf(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return '';
  return m.content.map((p) => (p.type === 'text' ? p.text : '[图片]')).join('\n');
}

/** 把消息转成给压缩模型看的文字记录 */
export function transcript(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const t = textOf(m);
      if (t.startsWith(SCREENSHOT_MARKER)) lines.push('（工具返回了一张截图）');
      else lines.push(`用户：${t}`);
    } else if (m.role === 'assistant') {
      const t = textOf(m).trim();
      if (t) lines.push(`AI：${t}`);
      for (const c of m.tool_calls ?? []) lines.push(`AI 调用工具 ${c.function.name}：${clip(c.function.arguments, ARGS_LIMIT)}`);
    } else if (m.role === 'tool') {
      lines.push(`工具结果：${clip(textOf(m), TOOL_RESULT_LIMIT)}`);
    }
  }
  return lines.join('\n');
}

/** 真正由用户发出的消息（不含工具截图、摘要）的下标 */
function userTurnIndexes(history: ChatMessage[]): number[] {
  const out: number[] = [];
  history.forEach((m, i) => {
    if (m.role !== 'user') return;
    const t = textOf(m);
    if (t.startsWith(SCREENSHOT_MARKER) || t.startsWith(SUMMARY_PREFIX)) return;
    out.push(i);
  });
  return out;
}

/** 能否压缩：至少要有比保留部分更早的对话 */
export function canCompress(history: ChatMessage[], keepTurns = 2): boolean {
  const turns = userTurnIndexes(history);
  return turns.length > keepTurns || (turns.length > 0 && turns.length === keepTurns && turns[0] > 2);
}

export interface CompressResult {
  history: ChatMessage[];
  /** 被压缩的消息条数 */
  compressed: number;
}

/**
 * 压缩历史：保留最近 keepTurns 轮（从用户消息开始，保证工具调用与结果成对），更早的部分换成摘要。
 * 没有可压缩的内容时返回 null。
 */
export async function compressHistory(
  history: ChatMessage[],
  opts: { llm: LlmConfig; fetch: FetchLike; keepTurns?: number; signal?: AbortSignal },
): Promise<CompressResult | null> {
  const keepTurns = opts.keepTurns ?? 2;
  const turns = userTurnIndexes(history);
  if (turns.length === 0) return null;
  // 保留部分从倒数第 keepTurns 轮用户消息开始；轮数不够时只保留最后一轮
  const cut = turns[Math.max(0, turns.length - keepTurns)];
  const older = history.slice(0, cut);
  if (older.length === 0) return null;

  const { message } = await chat(
    opts.llm,
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `以下是需要压缩的对话记录：\n\n${transcript(older)}` },
    ],
    opts.fetch,
    {},
    { signal: opts.signal },
  );
  const summary = textOf(message).trim();
  if (!summary) throw new Error('模型没有返回摘要');

  return {
    history: [
      { role: 'user', content: `${SUMMARY_PREFIX}\n${summary}` },
      { role: 'assistant', content: '好的，我已了解之前的进展，会在此基础上继续。' },
      ...history.slice(cut),
    ],
    compressed: older.length,
  };
}

/** 接口返回的错误是否表示上下文超长 */
export function isContextOverflow(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /context.{0,20}(length|window|limit)|maximum context|too many tokens|token.{0,10}(limit|exceed)|prompt is too long|上下文.{0,6}(超|过长|长度)|超出.{0,6}(上下文|长度)/i.test(msg);
}
