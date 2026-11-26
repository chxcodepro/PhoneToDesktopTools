// 虚拟桌面画面上的叠加层：鼠标箭头、Agent 操作标记。

import { View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

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
