// 连上电脑后，设备记录里还没有系统名（旧版电脑端不告知）时，调一次 sys_info 读出系统版本，用来显示 Win7 / Win11 等图标。

import type { McpClient } from '@/protocol/mcpClient';

import { getDevice, upsertDevice } from './devices';
import { osNameFromVersion } from './osInfo';

const asked = new Set<string>();

export function learnOsName(pcId: string | null | undefined, client: McpClient | null | undefined): void {
  if (!pcId || !client || asked.has(pcId)) return;
  const dev = getDevice(pcId);
  if (!dev || dev.osName) return;
  asked.add(pcId);
  client
    .callTool('sys_info', {})
    .then((r) => {
      const text = r.content.find((c) => c.type === 'text');
      if (!text || text.type !== 'text') return;
      const info = JSON.parse(text.text) as { os?: string; os_version?: string };
      const name = osNameFromVersion(info.os ?? dev.os, info.os_version);
      if (name) upsertDevice({ pcId, osName: name });
    })
    .catch(() => asked.delete(pcId));
}
