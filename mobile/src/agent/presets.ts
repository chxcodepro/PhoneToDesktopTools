// 大模型预设（docs/PLAN.md 第 4.5 节）。
// 统一走 OpenAI 协议；模型列表运行时从 GET {baseURL}/models 拉取，这里不写死模型名。

/** OpenAI 预设接口地址（请填写） */
export const OPENAI_BASE_URL = '<OPENAI_BASE_URL>';
/** DeepSeek 预设接口地址（请填写） */
export const DEEPSEEK_BASE_URL = '<DEEPSEEK_BASE_URL>';

export type PresetId = 'openai' | 'deepseek' | 'custom';

export interface ModelPreset {
  id: PresetId;
  label: string;
  /** 接口地址；自定义预设由用户填写 */
  baseUrl: string;
  /** 是否支持图片输入（不支持时看屏幕改用 OCR + 控件树） */
  supportsVision: boolean;
  /** 是否支持工具调用 */
  supportsTools: boolean;
}

export const MODEL_PRESETS: readonly ModelPreset[] = [
  { id: 'openai', label: 'OpenAI', baseUrl: OPENAI_BASE_URL, supportsVision: true, supportsTools: true },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: DEEPSEEK_BASE_URL, supportsVision: false, supportsTools: true },
  { id: 'custom', label: '自定义', baseUrl: '', supportsVision: false, supportsTools: true },
];

export function getPreset(id: PresetId): ModelPreset {
  return MODEL_PRESETS.find((p) => p.id === id) ?? MODEL_PRESETS[0];
}
