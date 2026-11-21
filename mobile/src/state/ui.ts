// 界面全局状态：Agent 实时画面小窗是否打开；通过链接带进来、待填入输入框的文字。

import { createStore, useStore } from './store';

export interface UiState {
  /** Agent 页的实时画面小窗 */
  liveOpen: boolean;
  /** p2d://?draft= 链接带来的文字（seq 用于区分重复的同一段文字） */
  draft: { text: string; seq: number } | null;
}

export const uiStore = createStore<UiState>({ liveOpen: false, draft: null });

let draftSeq = 0;
export function setDraft(text: string): void {
  uiStore.set({ draft: { text, seq: ++draftSeq } });
}

export function useUi(): UiState {
  return useStore(uiStore);
}
