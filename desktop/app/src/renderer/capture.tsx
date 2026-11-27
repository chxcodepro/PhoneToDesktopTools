// 框选屏幕提问：全屏显示截图，拖出一块区域，松开后把这块（原始分辨率）交给助手；Esc 或右键取消。
import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import './styles.css';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function norm(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function Capture() {
  const [src, setSrc] = useState('');
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const img = useRef<HTMLImageElement>(null);

  useEffect(() => window.p2d.onCaptureImage(setSrc), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && window.p2d.captureDone(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const finish = (r: Rect) => {
    const el = img.current;
    if (!el || r.w < 8 || r.h < 8) {
      setStart(null);
      setRect(null);
      return;
    }
    // 截图是物理像素，窗口是 CSS 像素：按比例换算后裁出原始分辨率的那一块
    const sx = el.naturalWidth / el.clientWidth;
    const sy = el.naturalHeight / el.clientHeight;
    const c = document.createElement('canvas');
    c.width = Math.round(r.w * sx);
    c.height = Math.round(r.h * sy);
    c.getContext('2d')!.drawImage(el, r.x * sx, r.y * sy, r.w * sx, r.h * sy, 0, 0, c.width, c.height);
    window.p2d.captureDone(c.toDataURL('image/png'));
  };

  return (
    <div
      className="fixed inset-0 cursor-crosshair select-none overflow-hidden"
      onMouseDown={(e) => {
        if (e.button === 2) return window.p2d.captureDone(null);
        setStart({ x: e.clientX, y: e.clientY });
        setRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
      }}
      onMouseMove={(e) => start && setRect(norm(start, { x: e.clientX, y: e.clientY }))}
      onMouseUp={(e) => start && finish(norm(start, { x: e.clientX, y: e.clientY }))}
      onContextMenu={(e) => e.preventDefault()}
    >
      {src ? <img ref={img} src={src} className="absolute inset-0 h-full w-full" draggable={false} alt="" /> : null}
      {/* 选区外压暗 */}
      <div
        className="absolute border-2 border-[#8b5cf6]"
        style={
          rect
            ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h, boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)' }
            : { inset: 0, borderWidth: 0, boxShadow: 'inset 0 0 0 9999px rgba(0,0,0,0.3)' }
        }
      />
      {!rect ? (
        <div className="absolute left-1/2 top-6 -translate-x-1/2 rounded-full bg-slate-900/90 px-4 py-1.5 text-sm text-white">
          拖动鼠标框出要问的区域，Esc 取消
        </div>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Capture />);
