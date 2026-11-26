// Agent 对话附件：选图片 / 拍照 / 选文件，以及把文件分块上传到电脑（p2d/upload.*）。

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

import type { McpClient } from '@/protocol/mcpClient';

export interface ImageAttachment {
  kind: 'image';
  id: string;
  uri: string;
  name: string;
  width: number;
  height: number;
  /** 压缩后的 JPEG（base64），发给支持图片的模型 */
  base64: string;
  size: number;
}

export interface FileAttachment {
  kind: 'file';
  id: string;
  uri: string;
  name: string;
  size: number;
  mimeType?: string;
}

export type Attachment = ImageAttachment | FileAttachment;

/** 发给模型的图片最长边（像素）：再大对识别帮助不大，只会多消耗 token */
const IMAGE_MAX_SIDE = 1600;
const CHUNK_SIZE = 256 * 1024;

let seq = 0;
const newId = () => `att_${Date.now().toString(36)}_${(seq++).toString(36)}`;

async function toImageAttachment(a: { uri: string; width: number; height: number; fileName?: string | null }): Promise<ImageAttachment> {
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(a.width, a.height));
  const ctx = ImageManipulator.manipulate(a.uri);
  if (scale < 1) ctx.resize({ width: Math.round(a.width * scale), height: Math.round(a.height * scale) });
  const img = await ctx.renderAsync();
  const out = await img.saveAsync({ base64: true, compress: 0.8, format: SaveFormat.JPEG });
  const base64 = out.base64 ?? '';
  return {
    kind: 'image',
    id: newId(),
    uri: out.uri,
    name: a.fileName || `图片_${Date.now()}.jpg`,
    width: out.width,
    height: out.height,
    base64,
    size: Math.floor((base64.length * 3) / 4),
  };
}

/** 从相册选图片（可多选） */
export async function pickImages(limit = 6): Promise<ImageAttachment[]> {
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: limit,
    quality: 1,
  });
  if (res.canceled) return [];
  return Promise.all(res.assets.map(toImageAttachment));
}

/** 拍照 */
export async function takePhoto(): Promise<ImageAttachment[]> {
  // Android 通过系统相机拍照，不需要相机权限（清单里也没有声明，请求会直接返回拒绝）
  if (Platform.OS === 'ios') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error('没有相机权限，请在系统设置里允许');
  }
  const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
  if (res.canceled) return [];
  return Promise.all(res.assets.map(toImageAttachment));
}

/** 选文件（可多选） */
export async function pickFiles(): Promise<FileAttachment[]> {
  const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  if (res.canceled) return [];
  return res.assets.map((a) => ({
    kind: 'file',
    id: newId(),
    uri: a.uri,
    name: a.name,
    size: a.size ?? new File(a.uri).size ?? 0,
    mimeType: a.mimeType ?? undefined,
  }));
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const TEXT_EXT =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|ini|conf|cfg|log|html?|css|js|jsx|ts|tsx|py|java|kt|go|rs|c|cc|cpp|h|hpp|cs|sh|bat|ps1|sql|properties|toml)$/i;

/** 小的文本文件（电脑未连接时可以直接把内容交给模型） */
export function isSmallTextFile(f: FileAttachment): boolean {
  return f.size <= 100 * 1024 && (f.mimeType?.startsWith('text/') || TEXT_EXT.test(f.name));
}

export async function readText(f: FileAttachment): Promise<string> {
  return new File(f.uri).text();
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    s += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(s);
}

/** 读取附件的全部字节（以 CHUNK_SIZE 分块），逐块交给 onChunk */
async function readChunks(uri: string, onChunk: (b64: string, bytes: number) => Promise<void>): Promise<void> {
  const handle = new File(uri).open();
  try {
    for (;;) {
      const bytes = await handle.readBytes(CHUNK_SIZE);
      if (bytes.length === 0) break;
      await onChunk(bytesToBase64(bytes), bytes.length);
      if (bytes.length < CHUNK_SIZE) break;
    }
  } finally {
    handle.close();
  }
}

/**
 * 把附件上传到电脑的「下载/P2D」目录，返回电脑上的保存路径。
 * 图片上传的是压缩后的版本（与发给模型的一致）。
 */
export async function uploadToPc(client: McpClient, att: Attachment, onProgress?: (sent: number, total: number) => void): Promise<string> {
  return (await uploadToPcDetailed(client, att, { onProgress })).path;
}

/** 电脑端 p2d/upload.end 的返回 */
export interface PcUploadResult {
  path: string;
  size: number;
  sha256?: string;
  sha1?: string;
  /** Windows 数字签名：「状态|签名者」，如 "Valid|CN=Microsoft ..." */
  signature?: string;
}

/** 上传到电脑并返回保存路径、哈希；verify 为 true 时电脑端还会检查数字签名（Windows） */
export async function uploadToPcDetailed(
  client: McpClient,
  att: Attachment,
  opts: { onProgress?: (sent: number, total: number) => void; verify?: boolean; signal?: AbortSignal } = {},
): Promise<PcUploadResult> {
  const { onProgress, signal } = opts;
  const total = att.kind === 'image' ? Math.floor((att.base64.length * 3) / 4) - padding(att.base64) : att.size;
  const begin = (await client.request('p2d/upload.begin', { name: att.name, size: total })) as { id: string; path: string };
  try {
    let sent = 0;
    const sendChunk = async (b64: string, n: number) => {
      if (signal?.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' });
      await client.request('p2d/upload.chunk', { id: begin.id, data: b64 });
      sent += n;
      onProgress?.(sent, total);
    };
    if (att.kind === 'image') {
      // base64 每 4 个字符对应 3 个字节，按 4 的倍数切分
      const step = (CHUNK_SIZE / 3) * 4;
      for (let i = 0; i < att.base64.length; i += step) {
        const part = att.base64.slice(i, i + step);
        await sendChunk(part, Math.floor((part.length * 3) / 4) - padding(part));
      }
    } else {
      await readChunks(att.uri, sendChunk);
    }
    // 检查签名要启动 PowerShell，给足时间
    return (await client.request('p2d/upload.end', { id: begin.id, verify: !!opts.verify }, 90_000)) as PcUploadResult;
  } catch (e) {
    client.request('p2d/upload.cancel', { id: begin.id }).catch(() => undefined);
    throw e;
  }
}

function padding(b64: string): number {
  return b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
}
