// 「关于」页面：当前版本、检查更新。有新版本时用浏览器下载 APK 安装。
import Constants from 'expo-constants';
import { Info } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, Linking, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card, Separator } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { checkLatest, type UpdateResult } from '@/lib/update';

const CURRENT = Constants.expoConfig?.version ?? '0.0.0';
export const UPDATE_REPO = (Constants.expoConfig?.extra as { updateRepo?: string } | undefined)?.updateRepo;

export function AppUpdate() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateResult | null>(null);
  const check = () => {
    setChecking(true);
    void checkLatest(UPDATE_REPO, CURRENT)
      .then(setResult)
      .finally(() => setChecking(false));
  };
  return (
    <Card>
      <View className="flex-row items-center gap-3 px-3 py-3">
        <Icon as={Info} size={16} className="text-muted-foreground" />
        <Text className="flex-1 text-sm">版本 {CURRENT}</Text>
        {checking ? (
          <ActivityIndicator size="small" />
        ) : (
          <Button variant="outline" size="sm" onPress={check}>
            <Text>检查更新</Text>
          </Button>
        )}
      </View>
      {result ? (
        <>
          <Separator />
          <View className="gap-2 px-3 py-3">
            {result.state === 'latest' ? <Text className="text-sm text-muted-foreground">已是最新版本</Text> : null}
            {result.state === 'error' ? <Text className="text-sm text-destructive">{result.message}</Text> : null}
            {result.state === 'available' ? (
              <>
                <Text className="text-sm">发现新版本 {result.latest}</Text>
                <Text className="text-xs text-muted-foreground">
                  下载后点开安装包覆盖安装，配对记录和设置都会保留。插数据线连接已更新的电脑时，也会自动更新。
                </Text>
                <Button size="sm" className="self-start" onPress={() => void Linking.openURL(result.url)}>
                  <Text>下载新版本</Text>
                </Button>
              </>
            ) : null}
          </View>
        </>
      ) : null}
    </Card>
  );
}
