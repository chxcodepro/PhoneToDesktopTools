// 从底部弹出的面板（表单、详情等共用）。

import { X } from 'lucide-react-native';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';

export function Sheet({
  visible,
  title,
  onClose,
  children,
  scroll = true,
  fit = false,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  scroll?: boolean;
  /** 按内容高度只占屏幕底部（内容少的面板用），弹出键盘时整体上移 */
  fit?: boolean;
}) {
  if (fit) {
    return (
      <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
        <KeyboardAvoidingView style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' }} behavior="padding">
          <Pressable className="flex-1" onPress={onClose} />
          <SafeAreaView edges={['bottom']} className="max-h-[92%] rounded-t-3xl bg-background">
            <View className="flex-row items-center px-4 pb-2 pt-4">
              <Text className="flex-1 text-base font-semibold">{title}</Text>
              <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="关闭">
                <Icon as={X} size={18} className="text-muted-foreground" />
              </Pressable>
            </View>
            <View className="gap-3 px-4 pb-4">{children}</View>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </Modal>
    );
  }
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="h-[8%] bg-black/40" onPress={onClose} />
      <SafeAreaView edges={['bottom']} className="flex-1 rounded-t-3xl bg-background">
        <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
          <View className="flex-row items-center px-4 pb-2 pt-4">
            <Text className="flex-1 text-base font-semibold">{title}</Text>
            <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="关闭">
              <Icon as={X} size={18} className="text-muted-foreground" />
            </Pressable>
          </View>
          {scroll ? (
            <ScrollView contentContainerClassName="gap-3 px-4 pb-6" keyboardShouldPersistTaps="handled">
              {children}
            </ScrollView>
          ) : (
            <View className="flex-1 gap-3 px-4 pb-4">{children}</View>
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return <Text className="text-xs font-medium">{children}</Text>;
}
