// 手机端联网工具的实现：网页搜索（必应 RSS）、读取网页、微软更新目录（Microsoft Update Catalog）查驱动。
// 全部走手机自己的网络，电脑完全断网时也能用。不依赖 React Native，可在 Node 中测试。

import type { FetchLike } from './llm';

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const CATALOG = 'https://www.catalog.update.microsoft.com';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface PageLink {
  text: string;
  url: string;
}

export interface CatalogItem {
  /** 更新编号（用于获取下载地址） */
  id: string;
  title: string;
  products: string;
  classification: string;
  date: string;
  version: string;
  size: string;
}

export interface CatalogFile {
  url: string;
  fileName: string;
  /** 微软提供的 SHA-1（十六进制） */
  sha1: string | null;
}

/** 认为是「可下载文件」的扩展名，读网页时单独列出这类链接 */
const FILE_EXT = /\.(exe|msi|msu|cab|zip|7z|rar|inf|sys|dll|deb|rpm|tar|gz|xz|bz2|tgz|appimage|run|iso|img)(\?|#|$)/i;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s: string) =>
  decodeEntities(s.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return '';
  return stripTags(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, ''));
}

/** 解析必应搜索的 RSS 结果 */
export function parseBingRss(xml: string): SearchResult[] {
  const out: SearchResult[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const url = tag(m[1], 'link');
    if (url) out.push({ title: tag(m[1], 'title'), url, snippet: tag(m[1], 'description') });
  }
  return out;
}

function absUrl(href: string, base: string): string | null {
  try {
    const u = new URL(decodeEntities(href.trim()), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** 把网页转成纯文本，同时提取链接 */
export function htmlToText(html: string, baseUrl: string): { title: string; text: string; links: PageLink[] } {
  const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  const links: PageLink[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absUrl(m[1] ?? m[2] ?? m[3] ?? '', baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push({ text: stripTags(m[4]).slice(0, 120), url });
  }
  // 有 <main> / <article> 时只取正文部分，跳过导航栏、页脚等
  const main = html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? html.match(/<article\b[\s\S]*?<\/article>/i)?.[0];
  const body = (main && main.length > 500 ? main : html)
    .replace(/<(script|style|noscript|svg|head|nav|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/table|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' | ');
  const text = decodeEntities(body.replace(/<[^>]+>/g, ' '))
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return { title, text, links };
}

/** 解析微软更新目录的搜索结果页 */
export function parseCatalogSearch(html: string): CatalogItem[] {
  const out: CatalogItem[] = [];
  for (const m of html.matchAll(/<tr id="([0-9a-f-]{36})_R\d+"[\s\S]*?<\/tr>/gi)) {
    const id = m[1];
    const row = m[0];
    const cell = (n: number) => {
      const c = row.match(new RegExp(`id="${id}_C${n}_R\\d+"[^>]*>([\\s\\S]*?)</td>`, 'i'));
      return c ? stripTags(c[1]) : '';
    };
    const size = row.match(new RegExp(`id="${id}_size"[^>]*>([^<]*)<`, 'i'))?.[1]?.trim() ?? cell(6);
    out.push({ id, title: cell(1), products: cell(2), classification: cell(3), date: cell(4), version: cell(5), size });
  }
  return out;
}

/** 解析下载对话框返回的脚本：downloadInformation[0].files[0].url = '...' */
export function parseCatalogDownload(html: string): CatalogFile[] {
  const files = new Map<string, Partial<CatalogFile> & { digest?: string }>();
  for (const m of html.matchAll(/downloadInformation\[\d+\]\.files\[(\d+)\]\.(url|fileName|digest)\s*=\s*'([^']*)'/g)) {
    const f = files.get(m[1]) ?? {};
    if (m[2] === 'url') f.url = m[3];
    else if (m[2] === 'fileName') f.fileName = m[3];
    else f.digest = m[3];
    files.set(m[1], f);
  }
  const out: CatalogFile[] = [];
  for (const f of files.values()) {
    if (!f.url) continue;
    out.push({ url: f.url, fileName: f.fileName || f.url.split('/').pop() || 'download', sha1: f.digest ? base64ToHex(f.digest) : null });
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64ToHex(b64: string): string | null {
  const clean = b64.replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  let hex = '';
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) return null;
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      hex += ((value >> bits) & 0xff).toString(16).padStart(2, '0');
    }
  }
  return hex;
}

/** windowsupdate.com 的 http 链接改用 https（同一文件，两种协议都可下载） */
export function preferHttps(url: string): string {
  return /^http:\/\/([a-z0-9-]+\.)*windowsupdate\.com\//i.test(url) ? url.replace(/^http:/i, 'https:') : url;
}

/** 人机验证页面（Cloudflare、reCAPTCHA、hCaptcha、极验等）的特征 */
const BOT_MARKERS = [
  /<title>\s*(just a moment|attention required|请稍候|安全验证|security check)/i,
  /cdn-cgi\/challenge-platform|cf-chl-|cf_chl_opt|challenges\.cloudflare\.com/i,
  /class=["'][^"']*\b(g-recaptcha|h-captcha)\b/i,
  /static\.geetest\.com|captcha\.(qq|aliyun)\.com/i,
];

/** 内容是否是人机验证页面（而不是真正的网页或文件） */
export function isBotChallenge(text: string): boolean {
  const head = text.slice(0, 20000);
  return BOT_MARKERS.some((re) => re.test(head));
}

/** 遇到人机验证时告诉模型怎么办：不绕过，换来源或请用户手动下载 */
export const BOT_WALL_HINT =
  '该网站开启了人机验证（如 Cloudflare），不能自动访问，也不要尝试绕过。' +
  '请换用其他官方来源（如微软更新目录 driver_search、厂商的其他下载地址、系统软件源）；' +
  '确实只能从这里下载时，用 ask_user 请用户在手机浏览器打开该网址手动完成验证并下载，' +
  '下载好后在对话里点「＋ → 文件」选中它，App 会把文件传到电脑的「下载/PhoneToDesktop」目录。';

async function getText(
  fetch: FetchLike,
  url: string,
  signal?: AbortSignal,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
) {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...init.headers },
    body: init.body,
    signal,
  });
  const body = await res.text();
  if (isBotChallenge(body)) throw new Error(BOT_WALL_HINT);
  if (!res.ok) throw new Error(`请求失败（HTTP ${res.status}）：${url}`);
  return body;
}

/** 必应搜索（先试国内的 cn.bing.com，失败再试 www.bing.com） */
export async function webSearch(fetch: FetchLike, query: string, count = 8, signal?: AbortSignal): Promise<SearchResult[]> {
  let lastErr: unknown = null;
  for (const host of ['cn.bing.com', 'www.bing.com']) {
    try {
      const xml = await getText(fetch, `https://${host}/search?format=rss&q=${encodeURIComponent(query)}`, signal);
      const r = parseBingRss(xml);
      if (r.length) return r.slice(0, Math.max(1, Math.min(count, 20)));
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

export async function webFetch(fetch: FetchLike, url: string, signal?: AbortSignal) {
  const html = await getText(fetch, url, signal);
  return htmlToText(html, url);
}

/** 在微软更新目录按硬件 ID / 关键字搜索驱动和补丁 */
export async function catalogSearch(fetch: FetchLike, query: string, signal?: AbortSignal): Promise<CatalogItem[]> {
  const html = await getText(fetch, `${CATALOG}/Search.aspx?q=${encodeURIComponent(query)}`, signal);
  return parseCatalogSearch(html);
}

/** 获取微软更新目录中某个更新的下载地址 */
export async function catalogFiles(fetch: FetchLike, id: string, signal?: AbortSignal): Promise<CatalogFile[]> {
  const ids = JSON.stringify([{ size: 0, languages: '', uidInfo: id, updateID: id }]);
  const html = await getText(fetch, `${CATALOG}/DownloadDialog.aspx`, signal, {
    method: 'POST',
    body: `updateIDs=${encodeURIComponent(ids)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return parseCatalogDownload(html).map((f) => ({ ...f, url: preferHttps(f.url) }));
}

/** 网页文字太长时截断 */
export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…（已截断，共 ${s.length} 字）` : s;
}

/** 链接里挑出可下载文件（驱动、安装包、压缩包等） */
export function fileLinks(links: PageLink[]): PageLink[] {
  return links.filter((l) => FILE_EXT.test(l.url));
}
