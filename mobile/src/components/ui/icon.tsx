import type { LucideIcon, LucideProps } from 'lucide-react-native';
import { cssInterop } from 'nativewind';

import { cn } from '@/lib/utils';

type IconProps = LucideProps & { as: LucideIcon; className?: string };

function IconImpl({ as: IconComponent, ...props }: IconProps) {
  return <IconComponent {...props} />;
}

// 让 className 里的 text-* 颜色和 size-* 尺寸作用到 lucide 图标上
cssInterop(IconImpl, {
  className: {
    target: 'style',
    nativeStyleToProp: { height: 'size', width: 'size', color: true },
  },
});

/** lucide 图标，颜色用 className 控制，如 `text-primary` */
export function Icon({ as, className, size = 16, ...props }: IconProps) {
  return <IconImpl as={as} className={cn('text-foreground', className)} size={size} {...props} />;
}
