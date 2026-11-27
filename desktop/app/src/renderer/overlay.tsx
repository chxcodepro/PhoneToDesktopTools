// 被控提示：红色边框 + 顶部悬浮条（只在主显示器显示悬浮条）
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import type { AppStatus } from '../shared/types';
import './styles.css';

const query = new URLSearchParams(location.search);
const showBar = query.get('bar') === '1';
const agent = query.get('kind') === 'agent';

/** 电脑端 AI 助手在动键鼠：紫色边框 + 悬浮条（停止按钮、停止热键） */
function AgentOverlay() {
  const [stopKey, setStopKey] = useState('');
  useEffect(() => {
    void window.p2d.agentHotkeys().then((h) => setStopKey(h.stop.ok ? h.stop.label : ''));
  }, []);
  return (
    <div className="pointer-events-none fixed inset-0 border-4 border-[#8b5cf6]">
      {showBar && (
        <div
          className="pointer-events-auto absolute left-1/2 top-2 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full bg-slate-900/90 py-1 pl-3 pr-1 text-xs font-medium text-white shadow-lg"
          onMouseEnter={() => window.p2d.setOverlayInteractive(true)}
          onMouseLeave={() => window.p2d.setOverlayInteractive(false)}
        >
          <span className="h-[7px] w-[7px] rounded-full bg-[#8b5cf6]" />
          AI 助手正在操作电脑{stopKey ? `，按 ${stopKey} 停止` : ''}
          <button className="rounded-full bg-[#8b5cf6] px-3 py-0.5 text-white hover:bg-[#7c3aed]" onClick={() => window.p2d.stopAgent()}>
            停止
          </button>
        </div>
      )}
    </div>
  );
}

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

createRoot(document.getElementById('root')!).render(agent ? <AgentOverlay /> : <Overlay />);
