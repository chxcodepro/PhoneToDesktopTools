// 虚拟桌面坐标换算（纯函数，可在 Node 中测试）。

export interface FrameGeometry {
  width: number; // 图片宽度
  scale: number; // 图片尺寸 / 屏幕尺寸
  x: number; // 显示器左上角的屏幕坐标
  y: number;
}

/** 画面上的点（视图像素）→ 屏幕坐标 */
export function toScreen(f: FrameGeometry, viewW: number, px: number, py: number): { x: number; y: number } {
  const ratio = f.width / viewW; // 视图像素 → 图片像素
  return {
    x: Math.round((px * ratio) / f.scale + f.x),
    y: Math.round((py * ratio) / f.scale + f.y),
  };
}

/** 屏幕坐标 → 画面上的点（视图像素），用于绘制鼠标位置 */
export function toView(f: FrameGeometry, viewW: number, sx: number, sy: number): { left: number; top: number } {
  const k = (f.scale * viewW) / f.width;
  return { left: (sx - f.x) * k, top: (sy - f.y) * k };
}

// ---------- 画面缩放（双指捏合）----------
// 画面内容（未缩放时的视图像素 p）显示到容器上的位置：c = o + p * s（以左上角为原点缩放，再平移 o）。

export interface Zoom {
  s: number; // 缩放倍数，1 表示不缩放
  ox: number; // 平移（容器像素），范围 [W - W*s, 0]
  oy: number;
}

export const NO_ZOOM: Zoom = { s: 1, ox: 0, oy: 0 };
export const MAX_ZOOM = 5;

/** 容器上的点 → 画面内容上的点（未缩放的视图像素） */
export function unzoom(z: Zoom, cx: number, cy: number): { x: number; y: number } {
  return { x: (cx - z.ox) / z.s, y: (cy - z.oy) / z.s };
}

/** 限制缩放倍数和平移，保证画面始终铺满容器 */
export function clampZoom(z: Zoom, w: number, h: number): Zoom {
  const s = Math.max(1, Math.min(MAX_ZOOM, z.s));
  if (s <= 1.001) return NO_ZOOM;
  return {
    s,
    ox: Math.max(w - w * s, Math.min(0, z.ox)),
    oy: Math.max(h - h * s, Math.min(0, z.oy)),
  };
}

/**
 * 捏合：开始时两指中点下的画面内容跟着中点走，倍数按两指距离的比例变化。
 * start 是开始捏合时的缩放，m0/d0 是开始时的中点和距离，m/d 是现在的。
 */
export function pinchZoom(
  start: Zoom,
  m0: { x: number; y: number },
  d0: number,
  m: { x: number; y: number },
  d: number,
  w: number,
  h: number,
): Zoom {
  const p = unzoom(start, m0.x, m0.y);
  const s = Math.max(1, Math.min(MAX_ZOOM, (start.s * d) / Math.max(1, d0)));
  return clampZoom({ s, ox: m.x - p.x * s, oy: m.y - p.y * s }, w, h);
}
