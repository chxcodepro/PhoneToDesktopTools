// 被控提示：红色边框 + 顶部悬浮条（只在主显示器显示悬浮条）
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import type { AppStatus } from '../shared/types';
import './styles.css';

const showBar = new URLSearchParams(location.search).get('bar') === '1';

function Overlay() {
  const [s, setS] = useState<AppStatus>({ coreOnline: false });
  useEffect(() => {
    void window.p2d.getStatus().then(setS);
    return window.p2d.onStatus(setS);
  }, []);
  const name = s.controllerName ?? '手机';

  return (
    <div className="pointer-events-none fixed inset-0 border-4 border-[#ef4444]">
      {showBar && (
        <div
          className="pointer-events-auto absolute left-1/2 top-2 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full bg-slate-900/90 py-1 pl-3 pr-1 text-xs font-medium text-white shadow-lg"
          onMouseEnter={() => window.p2d.setOverlayInteractive(true)}
          onMouseLeave={() => window.p2d.setOverlayInteractive(false)}
        >
          <span className="h-[7px] w-[7px] rounded-full bg-[#ef4444]" />
          {name} 正在控制此电脑
          <button
            className="rounded-full bg-[#ef4444] px-3 py-0.5 text-white hover:bg-[#dc2626]"
            onClick={() => void window.p2d.disconnect()}
          >
            断开
          </button>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Overlay />);
