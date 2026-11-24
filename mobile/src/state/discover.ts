// 自动发现电脑用到的纯函数（不依赖 React Native，便于测试）。

export interface FoundPc {
  host: string;
  port: number;
  pcId: string;
  name: string;
  os?: string;
  osName?: string;
}

/** 和 ip 同一个 /24 网段的其他地址（1–254）；不是 IPv4 时返回空 */
export function subnetHosts(ip: string): string[] {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return [];
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255) || parts[0] === 0 || parts[0] === 127) return [];
  const base = parts.slice(0, 3).join('.');
  const out: string[] = [];
  for (let i = 1; i <= 254; i++) if (i !== parts[3]) out.push(`${base}.${i}`);
  return out;
}

/** 解析 /p2d/ping 的回应；不是本软件时返回 null */
export function parsePing(host: string, port: number, body: unknown): FoundPc | null {
  const b = body as { app?: unknown; pc?: unknown; name?: unknown; os?: unknown; osName?: unknown } | null;
  if (!b || b.app !== 'p2d' || typeof b.pc !== 'string' || !b.pc) return null;
  return {
    host,
    port,
    pcId: b.pc,
    name: typeof b.name === 'string' && b.name ? b.name : host,
    os: typeof b.os === 'string' ? b.os : undefined,
    osName: typeof b.osName === 'string' && b.osName ? b.osName : undefined,
  };
}
