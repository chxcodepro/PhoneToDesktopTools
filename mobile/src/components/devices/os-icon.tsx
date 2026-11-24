// 电脑系统的图标：按电脑端告知的系统名（osName，如 Windows 11、Kylin V10 SP1）区分系列。
// 旧版电脑端没有 osName 时只知道 windows / linux，显示通用的图标。

import { Monitor } from 'lucide-react-native';
import Svg, { Circle, Ellipse, Polygon, Rect, Text as SvgText } from 'react-native-svg';

import { Icon } from '@/components/ui/icon';
import type { OsFamily } from '@/state/osInfo';

/** 系统图标（正方形） */
export function OsIcon({ family, size = 40 }: { family: OsFamily; size?: number }) {
  switch (family) {
    case 'win11':
      return (
        <Svg width={size} height={size} viewBox="0 0 48 48">
          <Rect x={5} y={5} width={18} height={18} rx={1.5} fill="#0078D4" />
          <Rect x={25} y={5} width={18} height={18} rx={1.5} fill="#0078D4" />
          <Rect x={5} y={25} width={18} height={18} rx={1.5} fill="#0078D4" />
          <Rect x={25} y={25} width={18} height={18} rx={1.5} fill="#0078D4" />
        </Svg>
      );
    case 'win10':
    case 'win8':
    case 'windows':
      return (
        <Svg width={size} height={size} viewBox="0 0 48 48">
          <Polygon points="4,10 21,7.6 21,23 4,23" fill="#00A4EF" />
          <Polygon points="23,7.3 44,4.3 44,23 23,23" fill="#00A4EF" />
          <Polygon points="4,25 21,25 21,40.4 4,38" fill="#00A4EF" />
          <Polygon points="23,25 44,25 44,43.7 23,40.7" fill="#00A4EF" />
        </Svg>
      );
    case 'win7':
    case 'winxp':
      // 经典的四色视窗
      return (
        <Svg width={size} height={size} viewBox="0 0 48 48">
          <Polygon points="5,9 22,6 22,23 5,24" fill="#F25022" />
          <Polygon points="25,6 43,9 42,25 25,23" fill="#7FBA00" />
          <Polygon points="5,26 22,26 22,42 5,39" fill="#00A4EF" />
          <Polygon points="25,26 42,27 41,43 25,42" fill="#FFB900" />
        </Svg>
      );
    case 'kylin':
      return (
        <Svg width={size} height={size} viewBox="0 0 48 48">
          <Circle cx={24} cy={24} r={21} fill="#D7262B" />
          <SvgText x={24} y={31.5} fontSize={21} fontWeight="bold" fill="#FFFFFF" textAnchor="middle">
            麒
          </SvgText>
        </Svg>
      );
    case 'uos':
      return (
        <Svg width={size} height={size} viewBox="0 0 48 48">
          <Circle cx={24} cy={24} r={21} fill="#0069FF" />
          <SvgText x={24} y={29} fontSize={13} fontWeight="bold" fill="#FFFFFF" textAnchor="middle">
            UOS
          </SvgText>
        </Svg>
      );
    case 'ubuntu':
      return (
        <Svg width={size} height={size} viewBox="0 0 48 48">
          <Circle cx={24} cy={24} r={21} fill="#E95420" />
          <Circle cx={24} cy={24} r={9.5} fill="none" stroke="#FFFFFF" strokeWidth={3.5} />
          <Circle cx={13} cy={24} r={3.6} fill="#FFFFFF" stroke="#E95420" strokeWidth={1.5} />
          <Circle cx={29.5} cy={14.5} r={3.6} fill="#FFFFFF" stroke="#E95420" strokeWidth={1.5} />
          <Circle cx={29.5} cy={33.5} r={3.6} fill="#FFFFFF" stroke="#E95420" strokeWidth={1.5} />
        </Svg>
      );
    case 'linux':
      // 企鹅
      return (
        <Svg width={size} height={size} viewBox="0 0 48 48">
          <Ellipse cx={24} cy={25} rx={13} ry={18} fill="#1F2937" />
          <Ellipse cx={24} cy={30} rx={8.5} ry={11.5} fill="#FFFFFF" />
          <Circle cx={20} cy={15} r={3} fill="#FFFFFF" />
          <Circle cx={28} cy={15} r={3} fill="#FFFFFF" />
          <Circle cx={20.6} cy={15.4} r={1.3} fill="#111827" />
          <Circle cx={27.4} cy={15.4} r={1.3} fill="#111827" />
          <Ellipse cx={24} cy={20.5} rx={4.2} ry={2.3} fill="#F7B500" />
          <Ellipse cx={15} cy={42} rx={6.5} ry={3} fill="#F7B500" />
          <Ellipse cx={33} cy={42} rx={6.5} ry={3} fill="#F7B500" />
        </Svg>
      );
    default:
      return <Icon as={Monitor} size={size * 0.8} className="text-foreground" />;
  }
}
