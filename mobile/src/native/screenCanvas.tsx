// 虚拟桌面原生画布（modules/p2d-screen）：电脑端推来的分块画面在原生层解码、拼到画布上，
// 不经过 React 状态和 Image 组件（docs/PROTOCOL.md 5.2）。没有这个原生模块时（旧版安装包、测试环境）退回整帧推流。

import { requireNativeView, requireOptionalNativeModule } from 'expo';
import type { ComponentType } from 'react';
import { Platform, type ViewStyle } from 'react-native';

export interface TileData {
  x: number;
  y: number;
  w: number;
  h: number;
  data: string;
}

/** 手机硬件解码 H.264 的上限 */
export interface VideoCaps {
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
  /** 屏幕最高刷新率（旧安装包没有） */
  refresh?: number;
}

/** 送一帧视频的结果：ok 已显示，dropped 丢弃，needKey 要电脑端发关键帧 */
export type VideoResult = 'ok' | 'dropped' | 'needKey';

interface P2dScreenModule {
  draw(id: string, width: number, height: number, full: boolean, tiles: TileData[]): Promise<void>;
  release(id: string): void;
  // 旧版安装包没有下面这些（只有分块画布）
  videoCaps?(): VideoCaps | null;
  videoFeed?(id: string, data: Uint8Array, key: boolean, width: number, height: number): Promise<VideoResult>;
  videoRelease?(id: string): void;
}

const native =
  Platform.OS === 'android' || Platform.OS === 'ios' ? requireOptionalNativeModule<P2dScreenModule>('P2dScreen') : null;

export const canvasSupported = !!native;

const NativeCanvas: ComponentType<{ canvasId: string; style?: ViewStyle }> | null = native
  ? requireNativeView('P2dScreen')
  : null;

let nextId = 0;
/** 新画布 id（每次开始推流一个，旧推流还在路上的块不会画到新画布上） */
export function newCanvasId(): string {
  nextId += 1;
  return `c${nextId}`;
}

/** 把一帧的块画到画布上（按调用顺序执行），画完才返回 */
export async function drawTiles(id: string, width: number, height: number, full: boolean, tiles: TileData[]): Promise<void> {
  if (!native || tiles.length === 0) return;
  await native.draw(id, width, height, full, tiles);
}

export function releaseCanvas(id: string): void {
  native?.release(id);
}

/** 硬件解码视频的上限；不支持（旧安装包、没有硬件解码器）时返回 null，推流用分块 */
export function videoCaps(): VideoCaps | null {
  try {
    return native?.videoCaps?.() ?? null;
  } catch {
    return null;
  }
}

/** 把一帧 H.264（Annex B）交给原生解码器，显示完才返回 */
export async function feedVideo(id: string, data: Uint8Array, key: boolean, width: number, height: number): Promise<VideoResult> {
  if (!native?.videoFeed) return 'dropped';
  return native.videoFeed(id, data, key, width, height);
}

export function releaseVideo(id: string): void {
  native?.videoRelease?.(id);
}

const NativeVideo: ComponentType<{ videoId: string; style?: ViewStyle }> | null =
  native && typeof native.videoCaps === 'function' ? requireNativeView('P2dScreen', 'ScreenVideo') : null;

/** 显示一路硬件解码的视频，铺满父视图 */
export function ScreenVideo({ videoId, style }: { videoId: string; style?: ViewStyle }) {
  if (!NativeVideo) return null;
  return <NativeVideo videoId={videoId} style={style} />;
}

/** 显示一块画布，铺满父视图 */
export function ScreenCanvas({ canvasId, style }: { canvasId: string; style?: ViewStyle }) {
  if (!NativeCanvas) return null;
  return <NativeCanvas canvasId={canvasId} style={style} />;
}
