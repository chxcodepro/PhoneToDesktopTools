// 虚拟桌面推流：页面可见且已连接时订阅 p2d/screen.frame，离开页面时停止。
// 同时连着多台电脑时，推的是「正在看」的那台（uiStore.viewPc，Agent 操作哪台就切到哪台）。
// 有原生画布（modules/p2d-screen）时请求分块推流（p2d/screen.tiles）：画面数据直接交给原生层画，
// 这里只把尺寸、鼠标位置放进 React 状态；电脑端是旧版（不支持分块）时退回整帧推流（p2d/screen.frame）。

import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { canvasSupported, drawTiles, newCanvasId, releaseCanvas, type TileData } from '@/native/screenCanvas';
import { useViewTargets, viewClient } from '@/state/multi';

export interface ScreenFrame {
  /** 整帧推流的图片（data URI）；分块推流时为空，用 canvasId 显示原生画布 */
  uri: string;
  canvasId?: string;
  width: number;
  height: number;
  scale: number;
  x: number;
  y: number;
  display: number;
  cursorX?: number;
  cursorY?: number;
}

interface TilesParams {
  seq: number;
  full?: boolean;
  tiles?: TileData[];
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
  /** 有原生画布时用分块推流（只发变化的块，原生分辨率） */
  tiles?: boolean;
}

/** 电脑端是旧版、不支持分块推流时用的整帧参数 */
const LEGACY = { maxWidth: 1280, quality: 60, fps: 24 };

export function useScreenStream(display: number, opts: StreamOptions = {}): StreamState {
  const { enabled = true, maxWidth = 1280, quality = 60, fps: targetFps = 24, tiles = false } = opts;
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
    const useTiles = tiles && canvasSupported;
    const canvasId = useTiles ? newCanvasId() : '';
    // 每秒统计一次画面更新次数（只算有变化的帧）
    const tick = (changed: boolean): number | undefined => {
      const c = counter.current;
      if (changed) c.n++;
      const now = Date.now();
      if (now - c.since < 1000) return undefined;
      const fps = Math.round((c.n * 1000) / (now - c.since));
      c.n = 0;
      c.since = now;
      return fps;
    };

    // 分块帧按到达顺序画，画完回确认（电脑端最多等 2 帧没确认，手机画得慢时自动少发）
    let chain: Promise<void> = Promise.resolve();
    const offTiles = client.onNotification('p2d/screen.tiles', (raw) => {
      const p = raw as TilesParams;
      if (!useTiles) return;
      const list = p.tiles ?? [];
      chain = chain
        .then(() => drawTiles(canvasId, p.width, p.height, !!p.full, list))
        .catch(() => undefined)
        .then(() => {
          if (!alive) return;
          client.notify('p2d/screen.ack', { seq: p.seq });
          const fps = tick(list.length > 0);
          setState((s) => {
            const f = s.frame;
            if (
              fps === undefined &&
              s.error === null &&
              f &&
              f.canvasId === canvasId &&
              f.width === p.width &&
              f.height === p.height &&
              f.scale === p.scale &&
              f.x === p.x &&
              f.y === p.y &&
              f.display === p.display &&
              f.cursorX === p.cursorX &&
              f.cursorY === p.cursorY
            ) {
              return s; // 只有画面内容变了：原生画布已经更新，不用重新渲染页面
            }
            return {
              ...s,
              error: null,
              fps: fps ?? s.fps,
              frame: {
                uri: '',
                canvasId,
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
    });

    const offFrame = client.onNotification('p2d/screen.frame', (raw) => {
      const p = raw as FrameParams;
      const fps = tick(!!p.data);
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
      .request('p2d/screen.start', { display, maxWidth, quality, fps: targetFps, tiles: useTiles })
      .then((res) => {
        const r = res as { displays?: unknown[]; tiles?: boolean };
        const n = r.displays?.length ?? 1;
        if (alive) setState((s) => ({ ...s, displays: n, error: null }));
        // 旧版电脑端不认 tiles，会按这里请求的高分辨率推整帧：改用整帧推流的参数重新开始
        if (alive && useTiles && !r.tiles) {
          return client.request('p2d/screen.start', { display, ...LEGACY });
        }
        return undefined;
      })
      .catch((e: Error) => {
        if (alive) setState((s) => ({ ...s, error: e.message }));
      });

    return () => {
      alive = false;
      offTiles();
      if (canvasId) releaseCanvas(canvasId);
      offFrame();
      offError();
      offStopped();
      client.request('p2d/screen.stop', {}).catch(() => undefined);
    };
    // 换了要看的电脑（view.pcId）时重新订阅
  }, [enabled, focused, status, view.pcId, display, maxWidth, quality, targetFps, tiles]);

  return state;
}
