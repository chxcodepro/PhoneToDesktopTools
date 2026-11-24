// 底部操作面板：代替系统 Alert 做的「更多」菜单和删除确认。
// - ActionSheet：菜单；需要确认的操作（如删除）不再弹第二个系统对话框，而是在同一个面板里切换到确认页。
// - askConfirm()：单独的确认面板（代替 Alert.alert 的「取消 / 删除」），由根布局里的 <ConfirmHost /> 显示。

import type { LucideIcon } from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Card, Separator } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { createStore, useStore } from '@/state/store';

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** 确认按钮文字，默认「删除」 */
  confirmText?: string;
  icon?: LucideIcon;
  /** 危险操作（红色按钮），默认 true */
  destructive?: boolean;
}

export interface SheetAction {
  label: string;
  icon?: LucideIcon;
  /** 危险操作：红色 */
  destructive?: boolean;
  onPress: () => void;
  /** 执行前先确认 */
  confirm?: { title: string; message?: string; confirmText?: string };
}

/** 半透明背景 + 底部圆角面板 */
function BottomPanel({ visible, onClose, onBack, children }: { visible: boolean; onClose: () => void; onBack?: () => void; children: ReactNode }) {
  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onBack ?? onClose}>
      <View className="flex-1 justify-end" style={{ backgroundColor: 'rgba(0,0,0,0.4)' }}>
        <Pressable className="flex-1" onPress={onClose} accessibilityLabel="关闭" />
        <SafeAreaView edges={['bottom']} className="rounded-t-3xl bg-background">
          <View className="px-4 pb-3 pt-2">
            <View className="mb-3 h-1 w-10 self-center rounded-full bg-border" />
            {children}
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

/** 确认页：图标、标题、说明、取消 / 确认两个按钮 */
function ConfirmBody({ opts, onCancel, onConfirm }: { opts: ConfirmOptions; onCancel: () => void; onConfirm: () => void }) {
  const destructive = opts.destructive ?? true;
  return (
    <View className="items-center gap-2 pb-1 pt-2">
      {opts.icon ? (
        <View className={cn('mb-1 h-12 w-12 items-center justify-center rounded-full', destructive ? 'bg-destructive/10' : 'bg-primary/10')}>
          <Icon as={opts.icon} size={22} className={destructive ? 'text-destructive' : 'text-primary'} />
        </View>
      ) : null}
      <Text className="text-center text-base font-semibold">{opts.title}</Text>
      {opts.message ? <Text className="px-2 text-center text-sm leading-5 text-muted-foreground">{opts.message}</Text> : null}
      <View className="mt-3 w-full flex-row gap-3">
        <Button variant="outline" className="h-12 flex-1 rounded-xl" onPress={onCancel}>
          <Text>取消</Text>
        </Button>
        <Button variant={destructive ? 'destructive' : 'default'} className="h-12 flex-1 rounded-xl" onPress={onConfirm}>
          <Text>{opts.confirmText ?? '删除'}</Text>
        </Button>
      </View>
    </View>
  );
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

  const run = (a: SheetAction) => {
    if (a.confirm && confirming !== a) {
      setConfirming(a);
      return;
    }
    onClose();
    a.onPress();
  };

  return (
    <BottomPanel visible={visible} onClose={onClose} onBack={confirming ? () => setConfirming(null) : undefined}>
      {confirming?.confirm ? (
        <ConfirmBody
          opts={{ ...confirming.confirm, confirmText: confirming.confirm.confirmText ?? confirming.label, icon: confirming.icon, destructive: !!confirming.destructive }}
          onCancel={() => setConfirming(null)}
          onConfirm={() => run(confirming)}
        />
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
          <Button variant="outline" className="mt-3 h-12 rounded-xl" onPress={onClose}>
            <Text>取消</Text>
          </Button>
        </>
      )}
    </BottomPanel>
  );
}

// ---- 单独的确认面板 ----

interface ConfirmState {
  open: boolean;
  /** 关闭后保留：淡出动画期间内容不变 */
  opts: ConfirmOptions | null;
  onConfirm: (() => void) | null;
}

const confirmStore = createStore<ConfirmState>({ open: false, opts: null, onConfirm: null });

/** 弹出确认面板，用户点确认后执行 onConfirm */
export function askConfirm(opts: ConfirmOptions, onConfirm: () => void): void {
  confirmStore.set({ open: true, opts, onConfirm });
}

/** 挂在根布局里，显示 askConfirm() 的面板 */
export function ConfirmHost() {
  const { open, opts, onConfirm } = useStore(confirmStore);
  const close = () => confirmStore.set({ open: false });
  return (
    <BottomPanel visible={open} onClose={close}>
      {opts ? (
        <ConfirmBody
          opts={opts}
          onCancel={close}
          onConfirm={() => {
            close();
            onConfirm?.();
          }}
        />
      ) : null}
    </BottomPanel>
  );
}
