// 电脑系统的图标：按电脑端告知的系统名（osName，如 Windows 11、Kylin V10 SP1）区分系列。
// 旧版电脑端没有 osName 时只知道 windows / linux，显示通用的图标。

import { Monitor } from 'lucide-react-native';
import { Image } from 'react-native';
import Svg, { Circle, Path, Polygon, Rect, Text as SvgText } from 'react-native-svg';

import { Icon } from '@/components/ui/icon';
import type { OsFamily } from '@/state/osInfo';

const TUX = require('@/assets/images/os/linux.png');

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
      // 经典的四色波浪旗（Windows XP / Vista / 7）。图形取自维基共享资源
      // 「Unofficial Windows logo variant - 2002–2012 (Multicolored).svg」（只由简单几何图形构成，公有领域）
      return (
        <Svg width={size} height={size} viewBox="0 -10 170 170">
          <Path d="M170 20.7c-33 13.7-49 6-63.2-3.6L90.8 73.5c14.3 9.7 31.5 17.7 63.2 3.5l16.3-56.3z" fill="#91C300" />
          <Path d="M63 134.2c-14.3-9.6-30-17.6-63-3.9l16.2-56.6c33-13.6 49-5.9 63.3 3.8L63 134.2z" fill="#00B4F1" />
          <Path d="M82.2 67.3a53.9 53.9 0 0 0-31-11.3c-8.7-.1-19.1 2.4-32.2 7.8L35.2 7.4c33.1-13.7 49-6 63.3 3.7L82.2 67.3z" fill="#F8682C" />
          <Path d="M88 83c14.4 9.6 30.3 17.3 63.3 3.6L135 142.8c-33 13.7-48.9 6-63.2-3.7L88.1 83z" fill="#FFC300" />
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
    case 'macos':
      // 不用苹果的商标图形：深色圆角方块里画一个 ⌘（Mac 键盘上的 Command 键符号）
      return (
        <Svg width={size} height={size} viewBox="0 0 48 48">
          <Rect x={4} y={4} width={40} height={40} rx={10} fill="#1D1D1F" />
          <SvgText x={24} y={32} fontSize={22} fill="#FFFFFF" textAnchor="middle">
            ⌘
          </SvgText>
        </Svg>
      );
    case 'linux':
      // 彩色企鹅 Tux（devicon，MIT 许可；原作 Larry Ewing，用 The GIMP 绘制）。原 SVG 有七百多个路径，预先渲染成 PNG
      return <Image source={TUX} style={{ width: size, height: size }} resizeMode="contain" />;
    default:
      return <Icon as={Monitor} size={size * 0.8} className="text-foreground" />;
  }
}
