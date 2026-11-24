// 虚拟桌面推流：页面可见且已连接时订阅 p2d/screen.frame，离开页面时停止。
// 同时连着多台电脑时，推的是「正在看」的那台（uiStore.viewPc，Agent 操作哪台就切到哪台）。

import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useViewTargets, viewClient } from '@/state/multi';

export interface ScreenFrame {
  uri: string;
  width: number;
  height: number;
  scale: number;
  x: number;
  y: number;
  display: number;
  cursorX?: number;
  cursorY?: number;
}

interface FrameParams {
  seq: number;
  data?: string;
  mimeType?: string;
  width: number;
  height: number;
  scale: number;
  x: number;
  y: number;
  display: number;
  cursorX?: number;
  cursorY?: number;
}

export interface StreamState {
  frame: ScreenFrame | null;
  displays: number;
  error: string | null;
  fps: number;
}

export interface StreamOptions {
  /** 为 false 时不推流（如小窗关闭） */
  enabled?: boolean;
  maxWidth?: number;
  quality?: number;
  fps?: number;
}

export function useScreenStream(display: number, opts: StreamOptions = {}): StreamState {
  const { enabled = true, maxWidth = 1280, quality = 60, fps: targetFps = 24 } = opts;
  const { view } = useViewTargets();
  const status = view.status;
  const [focused, setFocused] = useState(false);
  const [state, setState] = useState<StreamState>({ frame: null, displays: 1, error: null, fps: 0 });
  const counter = useRef({ n: 0, since: 0 });

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  useEffect(() => {
    const client = viewClient();
    if (!enabled || !focused || status !== 'connected' || !client) return;
    let alive = true;
    counter.current = { n: 0, since: Date.now() };

    const offFrame = client.onNotification('p2d/screen.frame', (raw) => {
      const p = raw as FrameParams;
      const c = counter.current;
      c.n++;
      const now = Date.now();
      let fps: number | undefined;
      if (now - c.since >= 1000) {
        fps = Math.round((c.n * 1000) / (now - c.since));
        c.n = 0;
        c.since = now;
      }
      setState((s) => {
        const prev = s.frame;
        const uri = p.data ? `data:${p.mimeType ?? 'image/jpeg'};base64,${p.data}` : prev?.uri;
        if (!uri) return s;
        return {
          ...s,
          error: null,
          fps: fps ?? s.fps,
          frame: {
            uri,
            width: p.width,
            height: p.height,
            scale: p.scale,
            x: p.x,
            y: p.y,
            display: p.display,
            cursorX: p.cursorX,
            cursorY: p.cursorY,
          },
        };
      });
    });
    const offError = client.onNotification('p2d/screen.error', (raw) => {
      setState((s) => ({ ...s, error: (raw as { message?: string }).message ?? '截图失败' }));
    });
    const offStopped = client.onNotification('p2d/screen.stopped', (raw) => {
      setState((s) => ({ ...s, error: (raw as { reason?: string }).reason ?? '推流已停止' }));
    });

    client
      .request('p2d/screen.start', { display, maxWidth, quality, fps: targetFps })
      .then((res) => {
        const n = (res as { displays?: unknown[] }).displays?.length ?? 1;
        if (alive) setState((s) => ({ ...s, displays: n, error: null }));
      })
      .catch((e: Error) => {
        if (alive) setState((s) => ({ ...s, error: e.message }));
      });

    return () => {
      alive = false;
      offFrame();
      offError();
      offStopped();
      client.request('p2d/screen.stop', {}).catch(() => undefined);
    };
    // 换了要看的电脑（view.pcId）时重新订阅
  }, [enabled, focused, status, view.pcId, display, maxWidth, quality, targetFps]);

  return state;
}
