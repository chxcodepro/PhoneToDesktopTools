// 模型配置：三个预设各自保存一份（切换预设不丢失）。
// API Key 存在系统安全存储（Android Keystore / iOS Keychain），其余配置存 AsyncStorage。

import * as SecureStore from 'expo-secure-store';

import { loadJson, saveJson } from '@/state/storage';
import { createStore, useStore } from '@/state/store';

import { defaultContextWindow } from './contextWindow';
import { configProblem, type LlmConfig } from './llm';
import { getPreset, MODEL_PRESETS, type PresetId } from './presets';

export interface PresetSettings {
  /** 选择的模型 */
  model: string;
  /** 自定义预设的名称和接口地址（OpenAI / DeepSeek 使用预置地址） */
  name: string;
  baseUrl: string;
  supportsVision: boolean;
  supportsTools: boolean;
  /** 最近一次拉取的模型列表 */
  models: string[];
  /** 用户指定的上下文长度（token）；不填时按模型名使用官方公布的默认值 */
  contextWindow?: number;
  /** 深度思考（仅 DeepSeek）；不填时为开启（与接口默认一致） */
  thinking?: boolean;
  /** 用户为这个渠道填写的系统提示词，加在内置提示词之后 */
  systemPrompt?: string;
}

export interface ModelConfigState {
  active: PresetId;
  presets: Record<PresetId, PresetSettings>;
  /** 是否已填写 API Key（Key 本身不放进内存状态，用时再读取） */
  hasKey: Record<PresetId, boolean>;
  ready: boolean;
}

const STORAGE_KEY = 'p2d.modelConfig.v1';
const keyName = (id: PresetId) => `p2d.apikey.${id}`;

function defaults(): Record<PresetId, PresetSettings> {
  const out = {} as Record<PresetId, PresetSettings>;
  for (const p of MODEL_PRESETS) {
    out[p.id] = {
      model: '',
      name: p.id === 'custom' ? '' : p.label,
      baseUrl: p.baseUrl,
      supportsVision: p.supportsVision,
      supportsTools: p.supportsTools,
      models: [],
    };
  }
  return out;
}

export const modelConfigStore = createStore<ModelConfigState>({
  active: 'openai',
  presets: defaults(),
  hasKey: { openai: false, deepseek: false, custom: false },
  ready: false,
});

let initPromise: Promise<void> | null = null;

export function initModelConfig(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const saved = await loadJson<Partial<Pick<ModelConfigState, 'active' | 'presets'>>>(STORAGE_KEY, {});
      const presets = defaults();
      for (const p of MODEL_PRESETS) {
        const s = saved.presets?.[p.id];
        if (s) presets[p.id] = { ...presets[p.id], ...s };
        // 预设的接口地址始终以代码中的预置值为准
        if (p.id !== 'custom') presets[p.id].baseUrl = p.baseUrl;
      }
      const hasKey = { openai: false, deepseek: false, custom: false } as Record<PresetId, boolean>;
      await Promise.all(
        MODEL_PRESETS.map(async (p) => {
          try {
            hasKey[p.id] = !!(await SecureStore.getItemAsync(keyName(p.id)));
          } catch {
            hasKey[p.id] = false;
          }
        }),
      );
      modelConfigStore.set({ active: saved.active ?? 'openai', presets, hasKey, ready: true });
    })();
  }
  return initPromise;
}

function persist(): Promise<void> {
  const { active, presets } = modelConfigStore.get();
  return saveJson(STORAGE_KEY, { active, presets });
}

export async function setActivePreset(id: PresetId): Promise<void> {
  modelConfigStore.set({ active: id });
  await persist();
}

export async function updatePreset(id: PresetId, patch: Partial<PresetSettings>): Promise<void> {
  const { presets } = modelConfigStore.get();
  modelConfigStore.set({ presets: { ...presets, [id]: { ...presets[id], ...patch } } });
  await persist();
}

export async function setApiKey(id: PresetId, key: string): Promise<void> {
  const k = key.trim();
  if (k) await SecureStore.setItemAsync(keyName(id), k);
  else await SecureStore.deleteItemAsync(keyName(id));
  modelConfigStore.set({ hasKey: { ...modelConfigStore.get().hasKey, [id]: !!k } });
}

export async function getApiKey(id: PresetId): Promise<string> {
  try {
    return (await SecureStore.getItemAsync(keyName(id))) ?? '';
  } catch {
    return '';
  }
}

/** 是否支持在输入框旁切换深度思考（DeepSeek 接口的 thinking 参数） */
export function supportsThinkingToggle(id: PresetId): boolean {
  return id === 'deepseek';
}

export function thinkingOn(s: Pick<PresetSettings, 'thinking'>): boolean {
  return s.thinking !== false;
}

export function setThinking(on: boolean): Promise<void> {
  return updatePreset(modelConfigStore.get().active, { thinking: on });
}

export interface ResolvedModel {
  llm: LlmConfig;
  label: string;
  supportsVision: boolean;
  supportsTools: boolean;
  /** 上下文长度（token） */
  contextWindow: number;
  /** 用户填写的系统提示词 */
  systemPrompt: string;
  /** 配置不完整时的原因 */
  problem: string | null;
}

/** 某个预设实际使用的上下文长度 */
export function contextWindowOf(s: Pick<PresetSettings, 'model' | 'contextWindow'>): number {
  return s.contextWindow && s.contextWindow > 0 ? s.contextWindow : defaultContextWindow(s.model);
}

/** 当前使用的模型（含 API Key） */
export async function resolveActiveModel(id = modelConfigStore.get().active): Promise<ResolvedModel> {
  const s = modelConfigStore.get().presets[id];
  const llm: LlmConfig = { baseUrl: s.baseUrl.trim(), apiKey: await getApiKey(id), model: s.model.trim() };
  // DeepSeek：https://api-docs.deepseek.com/guides/thinking_mode/ ，{"thinking": {"type": "enabled" | "disabled"}}
  if (supportsThinkingToggle(id)) llm.extraBody = { thinking: { type: thinkingOn(s) ? 'enabled' : 'disabled' } };
  const label = id === 'custom' ? s.name || '自定义' : getPreset(id).label;
  return {
    llm,
    label: s.model ? `${label} · ${s.model}` : label,
    supportsVision: s.supportsVision,
    supportsTools: s.supportsTools,
    contextWindow: contextWindowOf(s),
    systemPrompt: (s.systemPrompt ?? '').trim(),
    problem: configProblem(llm),
  };
}

export function useModelConfig(): ModelConfigState {
  return useStore(modelConfigStore);
}
