// 二级页面左上角的返回按钮：能返回就返回，从深链接直接打开时回到 Agent 首页。

import { router } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { Pressable } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';

export function goBack(): void {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

export function BackButton({ className, iconClassName }: { className?: string; iconClassName?: string }) {
  return (
    <Pressable
      onPress={goBack}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="返回"
      className={cn('-ml-1.5 h-8 w-8 items-center justify-center rounded-full active:bg-muted', className)}
    >
      <Icon as={ChevronLeft} size={22} className={iconClassName} />
    </Pressable>
  );
}
