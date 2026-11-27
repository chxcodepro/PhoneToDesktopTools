// 思考程度：在输入框旁选择。各渠道能选的档位不同（参考 DeepSeek Harness：关闭 / 低 / 高 / 最高四档）。
// DeepSeek：https://api-docs.deepseek.com/guides/thinking_mode/
//   thinking.type 开关思考，reasoning_effort 取 low / high / max（medium、xhigh 会被当成 high）
// OpenAI 及兼容接口：reasoning_effort 取 low / medium / high，不同模型支持的值不一样，
//   接口不认这个参数时 llm.ts 会自动去掉再试一次

import type { PresetId } from './presets';

export type ReasoningLevel = 'default' | 'off' | 'low' | 'medium' | 'high' | 'max';

export interface ReasoningOption {
  id: ReasoningLevel;
  label: string;
  hint: string;
}

const OPTIONS: Record<ReasoningLevel, ReasoningOption> = {
  default: { id: 'default', label: '默认', hint: '不指定，用模型自己的默认值' },
  off: { id: 'off', label: '关闭', hint: '不思考，回答最快' },
  low: { id: 'low', label: '低', hint: '简单任务，回答快' },
  medium: { id: 'medium', label: '中', hint: '一般任务' },
  high: { id: 'high', label: '高', hint: '日常任务，推荐' },
  max: { id: 'max', label: '最高', hint: '复杂任务，更慢、用量更多' },
};

/** OpenAI 能调思考程度的模型：o 系列、GPT-5 及以后 */
const OPENAI_REASONING = /^(o\d|gpt-([5-9]|\d{2}))/i;

/** 这个渠道、模型能选的档位，从快到强排列；空数组表示不能调 */
export function reasoningOptions(preset: PresetId, model: string): ReasoningOption[] {
  const ids: ReasoningLevel[] =
    preset === 'deepseek'
      ? ['off', 'low', 'high', 'max']
      : preset === 'openai'
        ? OPENAI_REASONING.test(model.trim())
          ? ['default', 'low', 'medium', 'high']
          : []
        : ['default', 'low', 'medium', 'high'];
  return ids.map((id) => OPTIONS[id]);
}

export function defaultReasoning(preset: PresetId): ReasoningLevel {
  return preset === 'deepseek' ? 'high' : 'default';
}

/**
 * 实际使用的档位；不能调时返回 null。
 * legacyThinking：旧版只有「深度思考」开关，关掉的按「关闭」处理。
 */
export function effectiveReasoning(
  preset: PresetId,
  model: string,
  saved: ReasoningLevel | undefined,
  legacyThinking?: boolean,
): ReasoningLevel | null {
  const opts = reasoningOptions(preset, model);
  if (opts.length === 0) return null;
  const want = saved ?? (legacyThinking === false ? 'off' : defaultReasoning(preset));
  return opts.some((o) => o.id === want) ? want : defaultReasoning(preset);
}

export function reasoningLabel(level: ReasoningLevel): string {
  return OPTIONS[level].label;
}

/** 要加到请求体里的参数 */
export function reasoningBody(preset: PresetId, level: ReasoningLevel | null): Record<string, unknown> | undefined {
  if (!level || level === 'default') return undefined;
  if (preset === 'deepseek') {
    return level === 'off' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' }, reasoning_effort: level };
  }
  return { reasoning_effort: level === 'max' ? 'high' : level === 'off' ? 'none' : level };
}
