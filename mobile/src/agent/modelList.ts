// 模型列表的筛选：接口返回的模型很多时（如 OpenAI 上百个），按关键字搜索，并默认隐藏不能用来对话的模型。

/** 不能用于对话的模型：向量、语音、绘图、审核、旧版补全等 */
const NON_CHAT =
  /(embed|tts|whisper|transcribe|speech|audio|realtime|dall-e|image|sora|moderation|davinci|babbage|curie|ada-|search-preview|computer-use|rerank|ocr)/i;

export function isChatModel(id: string): boolean {
  return !NON_CHAT.test(id);
}

/** 列表多于这个数量时改用带搜索的选择框 */
export const PICKER_THRESHOLD = 8;

export interface ModelFilterResult {
  items: string[];
  /** 被「隐藏非对话模型」过滤掉的数量 */
  hidden: number;
}

/**
 * 搜索：空格分隔的多个关键字都要出现（不区分大小写）。
 * 排序：当前选中的放最前，其余按名称排序（数字按大小比较，gpt-4.1 排在 gpt-4o 前、gpt-10 排在 gpt-9 后）。
 */
export function filterModels(list: string[], query: string, opts: { hideNonChat: boolean; selected?: string }): ModelFilterResult {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  let hidden = 0;
  const items = [...new Set(list)].filter((m) => {
    const lower = m.toLowerCase();
    if (!words.every((w) => lower.includes(w))) return false;
    if (opts.hideNonChat && !isChatModel(m) && m !== opts.selected) {
      hidden++;
      return false;
    }
    return true;
  });
  items.sort((a, b) => {
    if (a === opts.selected) return -1;
    if (b === opts.selected) return 1;
    return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
  });
  return { items, hidden };
}
