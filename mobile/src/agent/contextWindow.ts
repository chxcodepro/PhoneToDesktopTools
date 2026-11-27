// 各模型的上下文长度（token），按官方公布的数据（2026年11月核对）。
// 优先级：用户在设置里填的 > 接口 /models 声明的（见 llm.ts listModelsDetailed）> 这里按模型名推断的。
// 匹配规则按顺序，先写更具体的；名字里带「-32k」「-128k」这类长度的以名字为准。

export const FALLBACK_CONTEXT_WINDOW = 128_000;

const K = 1000;
const M = 1_000_000;
/** DeepSeek 官方 /models 声明的长度（V4 起所有官方模型都是 1M） */
const DEEPSEEK_1M = 1_048_576;
/** OpenAI GPT-5.4 起的 1M 档 */
const OPENAI_1M = 1_050_000;

const RULES: [RegExp, number][] = [
  // OpenAI
  [/gpt-5\.[0-3]?-?(mini|nano)|gpt-5-(mini|nano)|gpt-5\.4-(mini|nano)/i, 400 * K],
  [/gpt-5\.([4-9]|\d{2})|gpt-([6-9]|\d{2})/i, OPENAI_1M],
  [/gpt-4\.1/i, 1_047_576],
  [/gpt-5/i, 400 * K],
  [/o[134](-mini|-pro)?|^o[134]/i, 200 * K],
  [/gpt-4o|gpt-4-turbo|chatgpt-4o/i, 128 * K],
  [/gpt-4-32k/i, 32 * K],
  [/gpt-4/i, 8 * K],
  [/gpt-3\.5/i, 16 * K],
  // DeepSeek：官方接口（V4 起，含 deepseek-chat / deepseek-reasoner 这些旧名字）都是 1M；
  // 本机部署的老模型（如 Ollama 的 deepseek-r1:14b、deepseek-v3）仍按 128K
  [/^deepseek-(v4|flash|pro|chat|reasoner)|deepseek-v4/i, DEEPSEEK_1M],
  [/deepseek/i, 128 * K],
  // 通义千问
  [/qwen-long/i, 10 * M],
  [/qwen[\d.]*-(plus|turbo|flash)|qwen-(plus|turbo|flash)/i, M],
  [/qwen-?3\.[5-9]|qwen-?3-(max|coder)/i, 262_144],
  [/qwen-max/i, 32 * K],
  [/qwen/i, 128 * K],
  // Kimi / Moonshot
  [/kimi-k3/i, 1_048_576],
  [/kimi-k2/i, 256 * K],
  [/kimi/i, 128 * K],
  // 智谱
  [/glm-4-long/i, M],
  [/glm-(5|4\.[5-9])/i, 200 * K],
  [/glm/i, 128 * K],
  // MiniMax
  [/minimax-?m3/i, M],
  [/minimax-?m2/i, 204_800],
  // Claude：Opus 4.6 / Sonnet 4.6 起和 Claude 5 系列都是 1M
  [/claude-(opus|sonnet)-4-[6-9]|claude-(opus|sonnet|fable|haiku)-[5-9]|claude-[5-9]/i, M],
  [/claude/i, 200 * K],
  // Gemini
  [/gemini-1\.5-pro/i, 2 * M],
  [/gemini/i, 1_048_576],
  // 其他常见
  [/grok-4\.[3-9]/i, M],
  [/llama-?3\.[1-9]|llama-?4/i, 128 * K],
  [/mistral-large|mistral-medium/i, 128 * K],
];

/** 按模型名推断默认上下文长度 */
export function defaultContextWindow(model: string): number {
  const m = model.trim();
  if (!m) return FALLBACK_CONTEXT_WINDOW;
  // 名字里直接带长度，如 moonshot-v1-32k、doubao-pro-256k
  const inName = /(?:^|[-_])(\d{1,4})k(?:$|[-_])/i.exec(m);
  if (inName) return Number(inName[1]) * K;
  for (const [re, n] of RULES) if (re.test(m)) return n;
  return FALLBACK_CONTEXT_WINDOW;
}

export function formatWindow(n: number): string {
  if (n >= M) {
    // 1,048,576、1,050,000 这类都显示成 1M
    const v = n / M;
    return Math.abs(v - Math.round(v)) < 0.06 ? `${Math.round(v)}M` : `${+v.toFixed(1)}M`;
  }
  return `${Math.round(n / K)}K`;
}

/** 实际使用的上下文长度：用户填的 > 接口声明的 > 按模型名推断的 */
export function resolveContextWindow(model: string, opts: { custom?: number; listed?: Record<string, number> } = {}): number {
  if (opts.custom && opts.custom > 0) return opts.custom;
  const listed = opts.listed?.[model.trim()];
  if (listed && listed > 0) return listed;
  return defaultContextWindow(model);
}
