import * as React from 'react';
import { View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BackButton } from '@/components/back-button';
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
  /** 标题左侧显示返回按钮 */
  back?: boolean;
}

/** 页面容器：安全区 + 标题栏 + 内容 */
export function Screen({ title, right, subtitle, scroll = true, children, contentClassName, back = true }: ScreenProps) {
  const body = cn('gap-3 px-4 pb-6 pt-3', contentClassName);
  return (
    <SafeAreaView edges={['top', 'bottom']} className="flex-1 bg-background">
      {title ? (
        <View className="flex-row items-center gap-2 border-b border-border px-4 pb-3 pt-2">
          {back ? <BackButton /> : null}
          <View className="flex-1">
            <Text className="text-lg font-bold">{title}</Text>
            {subtitle}
          </View>
          {right}
        </View>
      ) : null}
      {scroll ? (
        // 输入框获得焦点时自动滚动到键盘上方
        <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={24}>
          <View className={body}>{children}</View>
        </KeyboardAwareScrollView>
      ) : (
        <View className={cn('flex-1', body)}>{children}</View>
      )}
    </SafeAreaView>
  );
}
