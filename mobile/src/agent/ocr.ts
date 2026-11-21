// 文字识别结果的整理：模型看不到图片时，把截图里的文字按阅读顺序排好，并换算成可以直接点击的屏幕坐标。
// 识别本身在手机上离线完成（src/native/ocr.ts → modules/p2d-ocr，Android ML Kit 中文模型）。

export interface OcrLine {
  text: string;
  /** 文字框左上角和尺寸，单位为图片像素 */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrResult {
  width: number;
  height: number;
  lines: OcrLine[];
}

/** 截图坐标 → 屏幕坐标：屏幕 = 截图 ÷ scale + 偏移 */
export interface ScreenTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** 识别结果最多交给模型的行数 / 字数，避免一张满屏文字的截图占满上下文 */
const MAX_LINES = 300;
const MAX_CHARS = 8000;

/** 从 screen_capture 返回的说明里读出换算公式（「屏幕坐标 = (截图x ÷ 0.6667 + 0, 截图y ÷ 0.6667 + 0)」） */
export function parseScreenTransform(text: string): ScreenTransform | null {
  const m = /截图x\s*÷\s*([\d.]+)\s*\+\s*(-?\d+)\s*,\s*截图y\s*÷\s*([\d.]+)\s*\+\s*(-?\d+)/.exec(text);
  if (!m) return null;
  const scale = Number(m[1]);
  if (!(scale > 0)) return null;
  return { scale, offsetX: Number(m[2]), offsetY: Number(m[4]) };
}

/** 按阅读顺序排序：先按行（纵向重叠超过一半算同一行），同一行内从左到右 */
export function sortLines(lines: OcrLine[]): OcrLine[] {
  const byTop = [...lines].filter((l) => l.text.trim()).sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: OcrLine[][] = [];
  for (const l of byTop) {
    const row = rows[rows.length - 1];
    const ref = row?.[0];
    const overlap = ref ? Math.min(ref.y + ref.h, l.y + l.h) - Math.max(ref.y, l.y) : 0;
    if (row && ref && overlap > Math.min(ref.h, l.h) / 2) row.push(l);
    else rows.push([l]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x));
}

/** 整理成交给模型的文字：每行「(x, y) 文字」，坐标为文字中心 */
export function formatOcr(result: OcrResult, transform: ScreenTransform | null): string {
  const sorted = sortLines(result.lines);
  if (!sorted.length) return '（截图中没有识别到文字）';
  const point = (l: OcrLine) => {
    const cx = l.x + l.w / 2;
    const cy = l.y + l.h / 2;
    return transform
      ? [Math.round(cx / transform.scale + transform.offsetX), Math.round(cy / transform.scale + transform.offsetY)]
      : [Math.round(cx), Math.round(cy)];
  };
  const out: string[] = [];
  let chars = 0;
  let shown = 0;
  for (const l of sorted) {
    const [x, y] = point(l);
    const line = `(${x}, ${y}) ${l.text.replace(/\s+/g, ' ').trim()}`;
    if (shown >= MAX_LINES || chars + line.length > MAX_CHARS) break;
    out.push(line);
    chars += line.length + 1;
    shown++;
  }
  const head = transform
    ? `共识别到 ${sorted.length} 行文字。坐标是文字中心的屏幕坐标，可直接用于 input_mouse 点击：`
    : `共识别到 ${sorted.length} 行文字。坐标是文字中心在截图中的像素位置：`;
  const tail = shown < sorted.length ? `\n……其余 ${sorted.length - shown} 行已省略。需要时可以用更具体的方式（如命令、读文件）获取。` : '';
  return `${head}\n${out.join('\n')}${tail}`;
}
