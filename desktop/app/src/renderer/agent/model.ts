// 电脑端助手的模型配置：和手机端一样三个预设（OpenAI、DeepSeek、自定义）各存一份，切换预设不丢。
// 配置存在数据目录的 agent/config.json，API Key 由主进程用系统加密存储保存（Windows 是 DPAPI），页面里不长期持有。
import { useEffect, useState, useSyncExternalStore } from 'react';
import { resolveContextWindow } from '@agent/contextWindow';
import { configProblem, type LlmConfig } from '@agent/llm';
import { getPreset, MODEL_PRESETS, type PresetId } from '@agent/presets';
import { defaultPrompt } from '@agent/promptPresets';
import { effectiveReasoning, reasoningBody, type ReasoningLevel } from '@agent/reasoning';

export function createStore<T extends object>(initial: T) {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<T> | ((s: T) => Partial<T>)) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      for (const f of subs) f();
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => {
        subs.delete(f);
      };
    },
  };
}

export type Store<T extends object> = ReturnType<typeof createStore<T>>;

export function useStore<T extends object>(s: Store<T>): T {
  return useSyncExternalStore(s.subscribe, s.get);
}

export interface PresetSettings {
  model: string;
  /** 自定义预设的名称和接口地址（OpenAI / DeepSeek 用预置地址） */
  name: string;
  baseUrl: string;
  supportsVision: boolean;
  supportsTools: boolean;
  /** 最近一次拉取的模型列表 */
  models: string[];
  /** 接口 /models 声明的各模型上下文长度（拉取模型列表时记下） */
  windows?: Record<string, number>;
  /** 用户指定的上下文长度（token）；不填时用接口声明的，再没有就按模型名取官方公布的值 */
  contextWindow?: number;
  /** 旧版的深度思考开关（仅 DeepSeek），已改用 reasoning；关掉的按「关闭」处理 */
  thinking?: boolean;
  /** 思考程度；不填用渠道默认（DeepSeek 为「高」，其他为模型默认） */
  reasoning?: ReasoningLevel;
  /** 加在内置提示词之后的要求 */
  systemPrompt?: string;
  /** 已经填过默认提示词（之后用户清空了也不再自动填） */
  promptFilled?: boolean;
}

export interface ModelState {
  active: PresetId;
  presets: Record<PresetId, PresetSettings>;
  hasKey: Record<PresetId, boolean>;
  ready: boolean;
}

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
      systemPrompt: defaultPrompt('desktop'),
      promptFilled: true,
    };
  }
  return out;
}

export const modelStore = createStore<ModelState>({
  active: 'deepseek',
  presets: defaults(),
  hasKey: { openai: false, deepseek: false, custom: false },
  ready: false,
});

let initPromise: Promise<void> | null = null;

export function initModel(): Promise<void> {
  initPromise ??= (async () => {
    const saved = ((await window.p2d.agent.config()) ?? {}) as Partial<Pick<ModelState, 'active' | 'presets'>>;
    const presets = defaults();
    let migrated = false;
    for (const p of MODEL_PRESETS) {
      const s = saved.presets?.[p.id];
      if (s) presets[p.id] = { ...presets[p.id], ...s };
      // 老版本没有默认提示词：没填过的补上（只补一次）
      if (s && !s.promptFilled) migrated = true;
      if (s && !s.promptFilled) presets[p.id] = { ...presets[p.id], systemPrompt: s.systemPrompt?.trim() ? s.systemPrompt : defaultPrompt('desktop'), promptFilled: true };
      if (p.id !== 'custom') presets[p.id].baseUrl = p.baseUrl;
    }
    const hasKey = { openai: false, deepseek: false, custom: false } as Record<PresetId, boolean>;
    await Promise.all(MODEL_PRESETS.map(async (p) => (hasKey[p.id] = !!(await window.p2d.agent.key(p.id)))));
    modelStore.set({ active: saved.active ?? 'deepseek', presets, hasKey, ready: true });
    if (migrated) await persist();
  })();
  return initPromise;
}

function persist(): Promise<void> {
  const { active, presets } = modelStore.get();
  return window.p2d.agent.saveConfig({ active, presets });
}

export function setActivePreset(id: PresetId): Promise<void> {
  modelStore.set({ active: id });
  return persist();
}

export function updatePreset(id: PresetId, patch: Partial<PresetSettings>): Promise<void> {
  const { presets } = modelStore.get();
  modelStore.set({ presets: { ...presets, [id]: { ...presets[id], ...patch } } });
  return persist();
}

export async function setApiKey(id: PresetId, key: string): Promise<void> {
  await window.p2d.agent.setKey(id, key.trim());
  modelStore.set({ hasKey: { ...modelStore.get().hasKey, [id]: !!key.trim() } });
}

export const getApiKey = (id: PresetId) => window.p2d.agent.key(id);

/** 某个预设当前的思考程度；这个模型不能调时为 null */
export function reasoningOf(id: PresetId, s: Pick<PresetSettings, 'model' | 'reasoning' | 'thinking'>): ReasoningLevel | null {
  return effectiveReasoning(id, s.model, s.reasoning, s.thinking);
}

export function setReasoning(level: ReasoningLevel): Promise<void> {
  return updatePreset(modelStore.get().active, { reasoning: level });
}

export function contextWindowOf(s: Pick<PresetSettings, 'model' | 'contextWindow' | 'windows'>): number {
  return resolveContextWindow(s.model, { custom: s.contextWindow, listed: s.windows });
}

export interface ResolvedModel {
  llm: LlmConfig;
  label: string;
  supportsVision: boolean;
  supportsTools: boolean;
  contextWindow: number;
  systemPrompt: string;
  problem: string | null;
}

export async function resolveActiveModel(id = modelStore.get().active): Promise<ResolvedModel> {
  const s = modelStore.get().presets[id];
  const llm: LlmConfig = { baseUrl: s.baseUrl.trim(), apiKey: await getApiKey(id), model: s.model.trim() };
  // 思考程度（见 @agent/reasoning）
  const extra = reasoningBody(id, reasoningOf(id, s));
  if (extra) llm.extraBody = extra;
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

/** Key、令牌是否加密保存（读一次就够，系统密钥环不会在运行中出现或消失） */
let encryptedOnce: Promise<boolean> | null = null;
export function useKeyEncrypted(): boolean | null {
  const [v, setV] = useState<boolean | null>(null);
  useEffect(() => {
    encryptedOnce ??= window.p2d.agent.keyEncrypted().catch(() => false);
    void encryptedOnce.then(setV);
  }, []);
  return v;
}

/** 保存方式的说明，照实写：加密不可用时说明是明文 */
export function keyStorageHint(encrypted: boolean | null): string {
  if (encrypted === false) return '保存在这台电脑上。这台电脑没有可用的系统密钥环，Key 以明文存在本机用户目录里';
  return '保存在这台电脑上，用系统的加密存储';
}

// ---------- 其他设置 ----------

/** 危险操作确认：risky 只确认高风险（管理员命令、删除、格式化之类），all 执行命令和改文件都确认，off 不确认 */
export type ConfirmMode = 'risky' | 'all' | 'off';

export interface AgentSettings {
  confirm: ConfirmMode;
}

export const settingsStore = createStore<AgentSettings & { ready: boolean }>({ confirm: 'risky', ready: false });

export async function initSettings(): Promise<void> {
  const saved = ((await window.p2d.agent.storeLoad('settings')) ?? {}) as Partial<AgentSettings>;
  settingsStore.set({ confirm: saved.confirm ?? 'risky', ready: true });
}

export function updateSettings(patch: Partial<AgentSettings>): Promise<void> {
  settingsStore.set(patch);
  const { confirm } = settingsStore.get();
  return window.p2d.agent.storeSave('settings', { confirm });
}
