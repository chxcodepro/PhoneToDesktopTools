// 「允许后台运行」提示：没允许时 ColorOS 等系统会在 App 切到后台几秒后断开和电脑的连接。

import { BatteryWarning } from 'lucide-react-native';
import { Platform, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { isColorOS, openAppSettings, requestBackground, useBackgroundAllowed, useBackgroundDropped, useBackgroundOk } from '@/native/keepAlive';

export function BackgroundCard() {
  const allowed = useBackgroundAllowed();
  const dropped = useBackgroundDropped();
  const ok = useBackgroundOk();
  // iOS 不允许 App 在后台一直联网：切到后台不久就会被挂起，回到前台后自动重连，只在真的断开过时说明一下
  if (Platform.OS === 'ios') {
    if (!dropped) return null;
    return (
      <Card className="gap-2.5 border-amber-500/40 bg-amber-500/5 p-3">
        <View className="flex-row items-center gap-2">
          <Icon as={BatteryWarning} size={16} className="text-amber-600" />
          <Text className="flex-1 text-sm font-medium">切到后台会断开电脑</Text>
        </View>
        <Text className="text-xs leading-5 text-muted-foreground">
          iOS 会在 App 切到后台不久后暂停它，和电脑的连接随之断开，回到 App 后会自动重连。让电脑执行较长的任务时，请保持 P2D 在前台（可以在「设置 → 显示与亮度 → 自动锁定」里把时间调长）。
        </Text>
      </Card>
    );
  }
  // 只在真的被断开过，或者既没打开「忽略电池优化」、也还没确认后台没问题时提示
  if (!dropped && (allowed || ok)) return null;
  const vendorTip = isColorOS
    ? '点「应用设置」，进入「耗电管理」，选「完全允许后台行为」。'
    : '点「应用设置」，在「耗电管理 / 电池」里允许后台运行（或关闭省电限制）。';
  return (
    <Card className="gap-2.5 border-amber-500/40 bg-amber-500/5 p-3">
      <View className="flex-row items-center gap-2">
        <Icon as={BatteryWarning} size={16} className="text-amber-600" />
        <Text className="flex-1 text-sm font-medium">切到后台会断开电脑</Text>
      </View>
      <Text className="text-xs leading-5 text-muted-foreground">
        {dropped
          ? `刚才 App 切到后台几秒后就和电脑断开了，手机系统还在限制它的后台网络。${vendorTip}改好回来后这条提示会消失，如果切到后台还被断开会再提示。`
          : `手机系统会在 App 切到后台几秒后关掉它的网络。先点「允许后台运行」，在弹出的系统窗口里选「允许」；${vendorTip}`}
      </Text>
      <View className="flex-row gap-2">
        {!allowed ? (
          <Button size="sm" className="flex-1" onPress={requestBackground}>
            <Text>允许后台运行</Text>
          </Button>
        ) : null}
        <Button size="sm" variant={allowed ? 'default' : 'outline'} className="flex-1" onPress={openAppSettings}>
          <Text>应用设置</Text>
        </Button>
      </View>
    </Card>
  );
}
