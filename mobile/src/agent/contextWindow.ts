// 各模型的上下文长度（token），按官方公布的数据。用户可在「设置 → 模型 → 上下文长度」里覆盖。
// 匹配规则按顺序，先写更具体的；名字里带「-32k」「-128k」这类长度的以名字为准。

export const FALLBACK_CONTEXT_WINDOW = 128_000;

const K = 1000;
const M = 1_000_000;

const RULES: [RegExp, number][] = [
  // OpenAI
  [/gpt-4\.1/i, 1_047_576],
  [/gpt-5/i, 400 * K],
  [/\bo[134](-mini|-pro)?\b|^o[134]/i, 200 * K],
  [/gpt-4o|gpt-4-turbo|chatgpt-4o/i, 128 * K],
  [/gpt-4-32k/i, 32 * K],
  [/gpt-4\b/i, 8 * K],
  [/gpt-3\.5/i, 16 * K],
  // DeepSeek（V3 / R1 系列及后续 API 模型均为 128K）
  [/deepseek/i, 128 * K],
  // 通义千问
  [/qwen-long/i, 10 * M],
  [/qwen-turbo|qwen-plus-latest|qwen-plus-2025/i, M],
  [/qwen-max/i, 32 * K],
  [/qwen/i, 128 * K],
  // Kimi / Moonshot
  [/kimi-k2-(0905|turbo)/i, 256 * K],
  [/kimi/i, 128 * K],
  // 智谱
  [/glm-4-long/i, M],
  [/glm/i, 128 * K],
  // 其他常见
  [/claude/i, 200 * K],
  [/gemini-1\.5-pro/i, 2 * M],
  [/gemini/i, 1_048_576],
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
  if (n >= M) return `${+(n / M).toFixed(n % M === 0 ? 0 : 1)}M`;
  return `${Math.round(n / K)}K`;
}
