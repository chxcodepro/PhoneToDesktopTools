// 虚拟桌面画面上的叠加层：鼠标箭头、触控准星、放大镜、Agent 操作标记。

import { View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { FrameImage } from '@/components/frame-image';
import type { ScreenFrame } from '@/remote/useScreenStream';

/** 鼠标箭头：黑底白边，任何背景上都看得清；尖端对准坐标点 */
export function CursorArrow({ left, top, size = 22 }: { left: number; top: number; size?: number }) {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', zIndex: 5, left: left - 2, top: top - 2 }}>
      <Svg width={size} height={size} viewBox="0 0 22 22">
        <Path
          d="M2 2 L2 18.5 L6.4 14.4 L9.4 20.6 L12.3 19.3 L9.4 13.2 L15.4 13.2 Z"
          fill="#000"
          stroke="#fff"
          strokeWidth={1.6}
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}

/** 触控模式的准星 */
export function Crosshair({ x, y }: { x: number; y: number }) {
  const r = 14;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', zIndex: 5, left: x - r, top: y - r }}>
      <Svg width={r * 2} height={r * 2}>
        <Circle cx={r} cy={r} r={r - 2} stroke="#fff" strokeWidth={3} fill="none" />
        <Circle cx={r} cy={r} r={r - 2} stroke="#2563eb" strokeWidth={1.5} fill="none" />
        <Line x1={r} y1={2} x2={r} y2={r * 2 - 2} stroke="#2563eb" strokeWidth={1} />
        <Line x1={2} y1={r} x2={r * 2 - 2} y2={r} stroke="#2563eb" strokeWidth={1} />
        <Circle cx={r} cy={r} r={1.6} fill="#ef4444" />
      </Svg>
    </View>
  );
}

const LOUPE = 128;
const ZOOM = 2.5;

/**
 * 放大镜：显示准星周围放大后的画面，帮助在小屏幕上点准。
 * 放在画面上与准星相反的一侧角落，避免挡住目标。
 */
export function Loupe({ frame, viewW, viewH, x, y }: { frame: ScreenFrame; viewW: number; viewH: number; x: number; y: number }) {
  const left = x < viewW / 2 ? viewW - LOUPE - 8 : 8;
  const top = 8;
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        zIndex: 5,
        left,
        top,
        width: LOUPE,
        height: LOUPE,
        borderRadius: LOUPE / 2,
        overflow: 'hidden',
        borderWidth: 3,
        borderColor: '#fff',
        backgroundColor: '#000',
      }}
    >
      <View
        style={{
          position: 'absolute',
          zIndex: 5,
          width: viewW * ZOOM,
          height: viewH * ZOOM,
          left: LOUPE / 2 - 3 - x * ZOOM,
          top: LOUPE / 2 - 3 - y * ZOOM,
        }}
      >
        <FrameImage uri={frame.uri} />
      </View>
      <View
        style={{
          position: 'absolute',
          zIndex: 5,
          left: LOUPE / 2 - 3 - 1,
          top: 10,
          width: 2,
          height: LOUPE - 26,
          backgroundColor: 'rgba(37,99,235,0.7)',
        }}
      />
      <View
        style={{
          position: 'absolute',
          top: LOUPE / 2 - 3 - 1,
          left: 10,
          height: 2,
          width: LOUPE - 26,
          backgroundColor: 'rgba(37,99,235,0.7)',
        }}
      />
    </View>
  );
}

/** Agent 操作位置标记（红色圆环） */
export function ActionMarker({ left, top }: { left: number; top: number }) {
  const r = 16;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', zIndex: 5, left: left - r, top: top - r }}>
      <Svg width={r * 2} height={r * 2}>
        <Circle cx={r} cy={r} r={r - 2} stroke="#fff" strokeWidth={4} fill="none" />
        <Circle cx={r} cy={r} r={r - 2} stroke="#ef4444" strokeWidth={2.5} fill="rgba(239,68,68,0.15)" />
        <Circle cx={r} cy={r} r={2.5} fill="#ef4444" />
      </Svg>
    </View>
  );
}
