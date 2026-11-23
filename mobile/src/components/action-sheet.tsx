// 底部操作面板：代替系统 Alert 做的「更多」菜单。
// 需要确认的操作（如删除）不再弹第二个系统对话框，而是在同一个面板里切换到确认页。

import type { LucideIcon } from 'lucide-react-native';
import { useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Card, Separator } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

export interface SheetAction {
  label: string;
  icon?: LucideIcon;
  /** 危险操作：红色 */
  destructive?: boolean;
  onPress: () => void;
  /** 执行前先确认 */
  confirm?: { title: string; message?: string; confirmText?: string };
}

export function ActionSheet({
  visible,
  title,
  subtitle,
  icon,
  actions,
  onClose,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  actions: SheetAction[];
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState<SheetAction | null>(null);
  // 每次打开时回到菜单页（关闭时不重置：淡出动画期间内容保持不变）
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) setConfirming(null);
  }
  const close = onClose;

  const run = (a: SheetAction) => {
    if (a.confirm && confirming !== a) {
      setConfirming(a);
      return;
    }
    close();
    a.onPress();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={confirming ? () => setConfirming(null) : close}
    >
      <View className="flex-1 justify-end" style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}>
        <Pressable className="flex-1" onPress={close} accessibilityLabel="关闭" />
        <SafeAreaView edges={['bottom']} className="rounded-t-3xl bg-background">
          <View className="px-4 pb-3 pt-2">
            <View className="mb-3 h-1 w-10 self-center rounded-full bg-border" />
            {confirming?.confirm ? (
              <View className="items-center gap-2 pb-1 pt-2">
                {confirming.icon ? (
                  <View className="mb-1 h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
                    <Icon as={confirming.icon} size={22} className="text-destructive" />
                  </View>
                ) : null}
                <Text className="text-center text-base font-semibold">{confirming.confirm.title}</Text>
                {confirming.confirm.message ? (
                  <Text className="px-2 text-center text-sm leading-5 text-muted-foreground">{confirming.confirm.message}</Text>
                ) : null}
                <View className="mt-3 w-full flex-row gap-3">
                  <Button variant="outline" className="h-12 flex-1 rounded-xl" onPress={() => setConfirming(null)}>
                    <Text>取消</Text>
                  </Button>
                  <Button
                    variant={confirming.destructive ? 'destructive' : 'default'}
                    className="h-12 flex-1 rounded-xl"
                    onPress={() => run(confirming)}
                  >
                    <Text>{confirming.confirm.confirmText ?? confirming.label}</Text>
                  </Button>
                </View>
              </View>
            ) : (
              <>
                <View className="flex-row items-center gap-3 px-1 pb-3">
                  {icon ? (
                    <View className="h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                      <Icon as={icon} size={18} className="text-primary" />
                    </View>
                  ) : null}
                  <View className="flex-1">
                    <Text numberOfLines={1} className="text-base font-semibold">
                      {title}
                    </Text>
                    {subtitle ? (
                      <Text numberOfLines={2} className="text-xs text-muted-foreground">
                        {subtitle}
                      </Text>
                    ) : null}
                  </View>
                </View>
                <Card className="overflow-hidden rounded-xl">
                  {actions.map((a, i) => (
                    <View key={a.label}>
                      {i > 0 ? <Separator /> : null}
                      <Pressable onPress={() => run(a)} className="flex-row items-center gap-3 px-4 py-3.5 active:bg-accent">
                        {a.icon ? <Icon as={a.icon} size={18} className={a.destructive ? 'text-destructive' : 'text-foreground'} /> : null}
                        <Text className={cn('text-[15px]', a.destructive && 'text-destructive')}>{a.label}</Text>
                      </Pressable>
                    </View>
                  ))}
                </Card>
                <Button variant="outline" className="mt-3 h-12 rounded-xl" onPress={close}>
                  <Text>取消</Text>
                </Button>
              </>
            )}
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
