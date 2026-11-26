// 黑屏：手机连着电脑时让电脑的显示器黑屏，旁边的人看不到在操作什么，手机上照常看得到画面、照常操作
// （和向日葵的「黑屏模式」、UU 远程的「防窥模式」一样）。断开连接后电脑端自动恢复显示。
// 选择按电脑分别记住，以后连上这台电脑就自动打开。电脑端要求 Windows 10 2004 及以上。

import type { McpClient } from '@/protocol/mcpClient';

import { getDevice, upsertDevice } from './devices';

/** 连上电脑后调用：这台电脑开过黑屏就重新打开（失败不影响连接） */
export async function applyBlank(mc: McpClient, pcId: string | null | undefined): Promise<void> {
  if (!pcId || !getDevice(pcId)?.blank) return;
  try {
    await mc.request('p2d/blank.set', { on: true }, 10_000);
  } catch {
    // 电脑端是旧版或系统不支持：不提示，用户在虚拟桌面里点开关时会看到原因
  }
}

/** 打开 / 关闭黑屏并记住选择；失败时返回原因 */
export async function setBlank(mc: McpClient | null, pcId: string | null | undefined, on: boolean): Promise<string | null> {
  if (!mc) return '没有连接电脑';
  try {
    await mc.request('p2d/blank.set', { on }, 10_000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (pcId && !on) upsertDevice({ pcId, blank: false });
    return /不支持的方法|Method not found/i.test(msg) ? '电脑端版本太旧，不支持黑屏，请更新电脑端' : msg;
  }
  if (pcId) upsertDevice({ pcId, blank: on });
  return null;
}
