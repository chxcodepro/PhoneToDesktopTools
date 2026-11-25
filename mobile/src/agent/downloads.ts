// 用手机的网络下载文件，再经 USB 传到电脑的「下载/p2d」目录。
// 电脑完全断网（网卡驱动坏了、没有可用 WiFi、USB 网络共享也用不了）时，驱动和安装包都靠这条路送过去。

import { Directory, File, Paths } from 'expo-file-system';

import type { McpClient } from '@/protocol/mcpClient';

import { formatSize, uploadToPcDetailed, type PcUploadResult } from './attachments';
import { BOT_WALL_HINT, isBotChallenge } from './web';

/** 与电脑端上传上限一致 */
const MAX_SIZE = 1024 * 1024 * 1024;

export interface DownloadProgress {
  (text: string): void;
}

/** 读取文件开头的若干字节（按 Latin-1 转成文字，只用来判断是不是网页） */
async function readHead(file: File, n: number): Promise<string> {
  const h = file.open();
  try {
    const bytes = await h.readBytes(Math.min(n, file.size ?? n));
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  } finally {
    h.close();
  }
}

export async function downloadToPc(
  client: McpClient,
  url: string,
  name: string,
  opts: { signal?: AbortSignal; onProgress?: DownloadProgress } = {},
): Promise<PcUploadResult> {
  const dir = new Directory(Paths.cache, `p2d-dl-${Date.now().toString(36)}`);
  dir.create({ intermediates: true, idempotent: true });
  try {
    let last = 0;
    const file = await File.downloadFileAsync(url, new File(dir, name), {
      idempotent: true,
      signal: opts.signal,
      onProgress: ({ bytesWritten, totalBytes }) => {
        const now = Date.now();
        if (now - last < 500) return;
        last = now;
        const pct = totalBytes > 0 ? ` ${Math.round((bytesWritten / totalBytes) * 100)}%` : '';
        opts.onProgress?.(`手机下载中${pct}（${formatSize(bytesWritten)}${totalBytes > 0 ? ` / ${formatSize(totalBytes)}` : ''}）`);
      },
    });
    const size = file.size ?? 0;
    if (size <= 0) throw new Error('下载的文件是空的');
    // 要的是安装包 / 驱动，拿到的却是网页：多半是人机验证、登录页或下载页本身
    if (!/\.html?$/i.test(name)) {
      const head = await readHead(file, 4096);
      if (isBotChallenge(head)) throw new Error(BOT_WALL_HINT);
      if (/^\s*(<!doctype html|<html)/i.test(head)) {
        throw new Error(
          '下载到的是网页而不是文件（可能需要登录、人机验证，或这个地址只是下载页）。请用 web_fetch 打开它找真正的文件链接，或换用其他官方来源。',
        );
      }
    }
    if (size > MAX_SIZE) throw new Error(`文件太大（${formatSize(size)}），超过 1 GB 上限`);
    opts.onProgress?.(`传到电脑 0%（${formatSize(size)}）`);
    return await uploadToPcDetailed(
      client,
      { kind: 'file', id: `dl_${Date.now().toString(36)}`, uri: file.uri, name, size },
      {
        verify: true,
        signal: opts.signal,
        onProgress: (sent, total) => {
          const now = Date.now();
          if (now - last < 500 && sent < total) return;
          last = now;
          opts.onProgress?.(`传到电脑 ${total ? Math.round((sent / total) * 100) : 100}%（${formatSize(total)}）`);
        },
      },
    );
  } finally {
    try {
      dir.delete();
    } catch {
      // 缓存目录删除失败不影响结果，系统会定期清理
    }
  }
}
