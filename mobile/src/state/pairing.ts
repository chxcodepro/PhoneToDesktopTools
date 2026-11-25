// 和电脑配对（不插线时）：扫电脑端「配对新手机」的二维码，或输入电脑 IP 后核对电脑上显示的 6 位配对码。
// 配对成功后保存密钥和电脑信息，并立即通过 WiFi 连接。

import type { PairLink } from '@/protocol/deepLink';
import { pairWithPc, type RawSocket } from '@/protocol/secure';
import { DEFAULT_LAN_PORT } from '@/protocol/types';

import { connectLan, findReachable } from './connection';
import { devicesStore, getDevice, getPairKey, initDevices, randomBytes, setPairKey, upsertDevice } from './devices';
import { createStore } from './store';

const createRaw = (url: string) => new WebSocket(url) as unknown as RawSocket;
const wsHost = (addr: string) => (addr.includes(':') ? `[${addr}]` : addr);

/** 系统相机扫到二维码打开 App 时，先放在这里，「设备」页接着处理 */
export const pendingPairStore = createStore<{ link: PairLink | null }>({ link: null });

export async function pairByQr(link: PairLink): Promise<string> {
  await initDevices();
  const d = devicesStore.get();
  const addr = await findReachable(link.addrs, link.port, link.pcId);
  const r = await pairWithPc({
    base: `ws://${wsHost(addr)}:${link.port}`,
    mode: 'qr',
    phoneId: d.phoneId,
    phoneName: d.phoneName,
    secret: link.secret,
    random: randomBytes,
    createRaw,
  });
  upsertDevice({
    pcId: r.pcId,
    mid: r.mid,
    name: r.name,
    os: r.os,
    osName: r.osName,
    addrs: r.addrs.length ? r.addrs : link.addrs,
    port: r.port || link.port,
    lastAddr: addr,
  });
  await setPairKey(r.pcId, r.key);
  void connectLan(r.pcId, { manual: true, addrs: [addr] }).catch(() => undefined);
  return r.pcId;
}

/**
 * 输入的 IP 是已经配对过的电脑（比如电脑后来登录了 Tailscale，手机还不知道这个地址）：
 * 直接用保存的密钥连接，不用再在电脑上点「配对新手机」。返回 pcId；没配对过返回 null；连不上抛错
 */
export async function connectKnownByAddress(host: string, port: number): Promise<string | null> {
  await initDevices();
  const ctl = new AbortController();
  // Tailscale 第一次可能经中继服务器，多等一会
  const timer = setTimeout(() => ctl.abort(), 6000);
  let info: { app?: string; pc?: string; name?: string };
  try {
    const r = await fetch(`http://${wsHost(host)}:${port}/p2d/ping`, { signal: ctl.signal });
    info = (await r.json()) as typeof info;
  } catch {
    throw new Error(
      `连不上 ${host}：请确认电脑端已打开、地址没输错，手机和电脑在同一个 WiFi（或者都连着同一个 Tailscale），并且电脑防火墙允许了 p2d。`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (info?.app !== 'p2d') throw new Error(`${host} 不是 p2d 电脑端`);
  const pcId = info.pc;
  if (!pcId || !(await getPairKey(pcId))) return null;
  const dev = getDevice(pcId);
  upsertDevice({
    pcId,
    name: dev?.name ?? info.name ?? '电脑',
    addrs: [host, ...(dev?.addrs ?? []).filter((a) => a !== host)],
    port,
    lastAddr: host,
  });
  await connectLan(pcId, { manual: true, addrs: [host] });
  return pcId;
}

/** 输入 IP（可带端口，如 192.168.1.5:39272） */
export function parseAddress(input: string): { host: string; port: number } | null {
  // 中文输入法容易打出全角的「。．：」和空格，统一换成半角
  const s = input
    .replace(/[。．｡]/g, '.')
    .replace(/[：]/g, ':')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .replace(/^(ws|http)s?:\/\//i, '')
    .replace(/\/.*$/, '');
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/.exec(s);
  if (!m) return null;
  if (m[1].split('.').some((x) => Number(x) > 255)) return null;
  const port = m[2] ? Number(m[2]) : DEFAULT_LAN_PORT;
  return port > 0 && port < 65536 ? { host: m[1], port } : null;
}

export async function pairByCode(
  host: string,
  port: number,
  askCode: (check: (code: string) => boolean) => Promise<string | null>,
): Promise<string> {
  await initDevices();
  const d = devicesStore.get();
  await findReachable([host], port, '');
  const r = await pairWithPc({
    base: `ws://${wsHost(host)}:${port}`,
    mode: 'code',
    phoneId: d.phoneId,
    phoneName: d.phoneName,
    random: randomBytes,
    createRaw,
    askCode,
  });
  upsertDevice({
    pcId: r.pcId,
    mid: r.mid,
    name: r.name,
    os: r.os,
    osName: r.osName,
    addrs: [host, ...r.addrs.filter((a) => a !== host)],
    port: r.port || port,
    lastAddr: host,
  });
  await setPairKey(r.pcId, r.key);
  void connectLan(r.pcId, { manual: true, addrs: [host] }).catch(() => undefined);
  return r.pcId;
}
