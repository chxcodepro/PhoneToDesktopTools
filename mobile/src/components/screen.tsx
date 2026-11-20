import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

export interface ScreenProps {
  title?: string;
  /** 标题栏右侧内容 */
  right?: React.ReactNode;
  /** 标题下方的副标题区域 */
  subtitle?: React.ReactNode;
  scroll?: boolean;
  children?: React.ReactNode;
  contentClassName?: string;
}

/** 页面容器：安全区 + 标题栏 + 内容 */
export function Screen({ title, right, subtitle, scroll = true, children, contentClassName }: ScreenProps) {
  const body = cn('gap-3 px-4 pb-6 pt-3', contentClassName);
  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-background">
      {title ? (
        <View className="flex-row items-center gap-3 border-b border-border px-4 pb-3 pt-2">
          <View className="flex-1">
            <Text className="text-lg font-bold">{title}</Text>
            {subtitle}
          </View>
          {right}
        </View>
      ) : null}
      {scroll ? (
        <ScrollView contentContainerClassName={body} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View className={cn('flex-1', body)}>{children}</View>
      )}
    </SafeAreaView>
  );
}
