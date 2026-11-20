// 远程桌面坐标换算（纯函数，可在 Node 中测试）。

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
