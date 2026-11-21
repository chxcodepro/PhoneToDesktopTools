// 解析电脑端通过 adb 下发的 Deep Link：
//   p2d://connect?token=<令牌>&host=<电脑名>&os=<windows|linux>&port=39271
// 纯函数，不依赖 React Native。

import { DEFAULT_PORT, type ConnectParams } from './types';

/** 解析连接 Deep Link，格式不对时返回 null */
export function parseConnectUrl(url: string | null | undefined): ConnectParams | null {
  if (!url) return null;
  const m = /^p2d:\/\/\/?connect\/?(?:\?(.*))?$/i.exec(url.trim());
  if (!m) return null;
  return parseConnectQuery(m[1] ?? '');
}

/** 解析查询串（也供 expo-router 的路由参数使用） */
export function parseConnectQuery(query: string | Record<string, unknown>): ConnectParams | null {
  const get = (k: string): string => {
    if (typeof query === 'string') {
      for (const part of query.split('&')) {
        const i = part.indexOf('=');
        const key = i >= 0 ? part.slice(0, i) : part;
        if (safeDecode(key) === k) return i >= 0 ? safeDecode(part.slice(i + 1)) : '';
      }
      return '';
    }
    const v = query[k];
    if (Array.isArray(v)) return String(v[0] ?? '');
    return v == null ? '' : String(v);
  };

  const token = get('token');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) return null;
  const portRaw = Number(get('port'));
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : DEFAULT_PORT;
  return {
    token,
    host: get('host') || '电脑',
    os: get('os') || 'unknown',
    port,
  };
}

/** 拼接 WebSocket 地址（只连本机回环，流量经 adb reverse 到电脑） */
export function buildWsUrl(params: Pick<ConnectParams, 'token' | 'port'>): string {
  return `ws://127.0.0.1:${params.port}/mcp?token=${encodeURIComponent(params.token)}`;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/** 草稿文字最长多少字 */
const MAX_DRAFT = 4000;

/**
 * 解析「填入输入框」链接：p2d://?draft=<文字> 或 p2d://agent?draft=<文字>。
 * 只把文字填进 Agent 输入框，不会自动发送（链接可能来自任意应用或网页）。
 */
export function parseDraftUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /^p2d:\/\/\/?(?:agent\/?)?\?(.*)$/i.exec(url.trim());
  if (!m) return null;
  for (const part of m[1].split('&')) {
    const i = part.indexOf('=');
    if (i > 0 && safeDecode(part.slice(0, i)) === 'draft') {
      const text = safeDecode(part.slice(i + 1)).trim();
      return text ? text.slice(0, MAX_DRAFT) : null;
    }
  }
  return null;
}
