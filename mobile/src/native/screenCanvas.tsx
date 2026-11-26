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

interface P2dScreenModule {
  draw(id: string, width: number, height: number, full: boolean, tiles: TileData[]): Promise<void>;
  release(id: string): void;
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

/** 显示一块画布，铺满父视图 */
export function ScreenCanvas({ canvasId, style }: { canvasId: string; style?: ViewStyle }) {
  if (!NativeCanvas) return null;
  return <NativeCanvas canvasId={canvasId} style={style} />;
}
