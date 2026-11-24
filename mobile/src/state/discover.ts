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

/** 手机的一个网卡地址（原生模块读出） */
export interface LocalNet {
  name: string;
  ip: string;
  prefix: number;
}

export type NetKind = 'wifi' | 'hotspot' | 'usb' | 'ethernet' | 'vpn' | 'tailscale';

/** 可以扫描的网段：局域网按所在的 /24 扫；Tailscale 网段太大，只探测记住的电脑在 Tailscale 里的地址 */
export interface ScanNet {
  /** 局域网为「192.168.31」这样的前三段；Tailscale 为 tailscale */
  id: string;
  kind: NetKind;
  label: string;
  ip: string;
}

const ipNum = (ip: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
};

const inRange = (ip: string, base: string, bits: number): boolean => {
  const a = ipNum(ip);
  const b = ipNum(base);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
};

/** Tailscale 的地址（100.64.0.0/10） */
export const isTailscaleIp = (ip: string) => inRange(ip, '100.64.0.0', 10);

/** 局域网私有地址 */
export const isPrivateIp = (ip: string) => inRange(ip, '10.0.0.0', 8) || inRange(ip, '172.16.0.0', 12) || inRange(ip, '192.168.0.0', 16);

/** 按网卡名猜是什么网络；移动数据（rmnet、ccmni 等）返回 null，不扫描 */
function kindOf(name: string, ip: string): NetKind | null {
  const n = name.toLowerCase();
  if (isTailscaleIp(ip)) return 'tailscale';
  if (/^(rmnet|ccmni|pdp|v4-rmnet|clat|dummy|seth|ims|r_rmnet)/.test(n)) return null;
  if (/^(ap|swlan|softap)/.test(n) || /^wlan[1-9]/.test(n)) return 'hotspot';
  if (/^wlan/.test(n)) return 'wifi';
  if (/^(rndis|usb|ncm)/.test(n)) return 'usb';
  if (/^(eth|en)/.test(n)) return 'ethernet';
  if (/^(tun|ppp|wg|ipsec|utun)/.test(n)) return 'vpn';
  return 'wifi';
}

const KIND_LABEL: Record<NetKind, string> = {
  wifi: 'WiFi',
  hotspot: '热点',
  usb: 'USB 共享',
  ethernet: '有线',
  vpn: 'VPN',
  tailscale: 'Tailscale',
};

/** 手机的网卡 → 可扫描的网段（同一个 /24 只留一个；WiFi 排在前面） */
export function scanNets(list: LocalNet[]): ScanNet[] {
  const out: ScanNet[] = [];
  for (const l of list) {
    const kind = kindOf(l.name, l.ip);
    if (!kind) continue;
    if (kind === 'tailscale') {
      if (!out.some((x) => x.id === 'tailscale')) out.push({ id: 'tailscale', kind, label: 'Tailscale', ip: l.ip });
      continue;
    }
    if (!isPrivateIp(l.ip)) continue;
    const id = l.ip.split('.').slice(0, 3).join('.');
    if (out.some((x) => x.id === id)) continue;
    out.push({ id, kind, label: `${KIND_LABEL[kind]} ${id}.x`, ip: l.ip });
  }
  const order: NetKind[] = ['wifi', 'ethernet', 'hotspot', 'usb', 'vpn', 'tailscale'];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}
