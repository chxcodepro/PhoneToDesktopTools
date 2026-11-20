import * as React from 'react';
import { View } from 'react-native';

import { cn } from '@/lib/utils';

import { Text, type TextProps } from './text';

type ViewProps = React.ComponentProps<typeof View> & { className?: string };

export function Card({ className, ...props }: ViewProps) {
  return <View className={cn('rounded-lg border border-border bg-card', className)} {...props} />;
}

export function CardContent({ className, ...props }: ViewProps) {
  return <View className={cn('p-4', className)} {...props} />;
}

/** 卡片内的分隔线 */
export function Separator({ className, ...props }: ViewProps) {
  return <View className={cn('h-px bg-border', className)} {...props} />;
}

/** 分组标题（设置页里的小标题） */
export function GroupTitle({ className, ...props }: TextProps) {
  return <Text className={cn('px-1 text-xs font-semibold text-muted-foreground', className)} {...props} />;
}
