// 输入框的「外部输入」：热键唤起、框选截图、编辑上一条消息时，把文字和附件交给输入框（助手页面可能还没打开）。
import type { Attachment } from './conversation';
import { createStore } from './model';

export interface ComposerBus {
  /** 每次要求聚焦输入框时加一 */
  focusSeq: number;
  /** 要放进输入框的文字（编辑上一条消息） */
  text?: string;
  /** 要加进输入框的附件 */
  attachments: Attachment[];
}

export const composerBus = createStore<ComposerBus>({ focusSeq: 0, attachments: [] });

export function pushToComposer(p: { text?: string; attachments?: Attachment[] } = {}): void {
  composerBus.set((s) => ({ focusSeq: s.focusSeq + 1, text: p.text ?? s.text, attachments: [...s.attachments, ...(p.attachments ?? [])] }));
}

export function takeFromComposerBus(): { text?: string; attachments: Attachment[] } {
  const { text, attachments } = composerBus.get();
  composerBus.set({ text: undefined, attachments: [] });
  return { text, attachments };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片打不开'));
    img.src = src;
  });
}

function scaled(img: HTMLImageElement, max: number, type: string, quality: number): string {
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff'; // 透明 PNG 转 JPEG 时底色用白色
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL(type, quality);
}

/** 图片附件：原图缩到长边 2000 像素以内（发给模型），另做一张缩略图（界面显示、存进对话记录） */
export async function imageAttachment(src: string, name: string, path?: string): Promise<Attachment> {
  const img = await loadImage(src);
  const big = Math.max(img.naturalWidth, img.naturalHeight) > 2000;
  return {
    kind: 'image',
    name,
    path,
    dataUrl: big ? scaled(img, 2000, 'image/jpeg', 0.9) : src,
    thumb: scaled(img, 240, 'image/jpeg', 0.8),
  };
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

function readAsDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('读不了这个文件'));
    r.readAsDataURL(f);
  });
}

/** 拖进来、选中的文件：图片按图片（也带路径），其他文件只给路径让助手用工具读 */
export async function fileAttachments(files: FileList | File[]): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const f of Array.from(files)) {
    const path = (f as File & { path?: string }).path || undefined;
    if (IMAGE_EXT.test(f.name) && f.size <= 20 * 1024 * 1024) {
      try {
        out.push(await imageAttachment(await readAsDataUrl(f), f.name, path));
        continue;
      } catch {
        // 打不开的图片按普通文件处理
      }
    }
    if (path) out.push({ kind: 'file', name: f.name, path });
  }
  return out;
}
