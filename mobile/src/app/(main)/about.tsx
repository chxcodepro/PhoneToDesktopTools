// 关于：版本和手机信息、检查更新、导出日志（分享，或存到连着的电脑）、项目主页（GitHub）。

import { Image } from 'expo-image';
import * as Sharing from 'expo-sharing';
import { ChevronRight, ExternalLink, FileDown, GitBranch, Monitor, Share2 } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, Linking, Pressable, View } from 'react-native';

import { uploadToPcDetailed } from '@/agent/attachments';
import { AppUpdate, UPDATE_REPO } from '@/components/app-update';
import { Screen } from '@/components/screen';
import { Card, GroupTitle, Separator } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { appLog, appVersion, deviceLabel, writeLogFile } from '@/lib/applog';
import { connectionStore, getClient, osLabel, useConnection } from '@/state/connection';

/** 本地打包的版本没有 updateRepo 时显示的项目主页 */
const HOME_REPO = 'chxcodepro/p2d';
const REPO_URL = `https://github.com/${UPDATE_REPO ?? HOME_REPO}`;

/** 导出日志时附上的连接情况（不含令牌） */
function connectionLines(): string[] {
  const c = connectionStore.get();
  const pc = c.params ? `${c.params.host}（${osLabel(c.params.os)}）` : '无';
  return [`连接：${c.status}${c.detail ? `（${c.detail}）` : ''}　通道：${c.route ?? '无'}　电脑：${pc}`];
}

export default function AboutScreen() {
  const { status } = useConnection();
  const [busy, setBusy] = useState<'share' | 'pc' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const share = async () => {
    setBusy('share');
    setResult(null);
    try {
      const f = writeLogFile(connectionLines());
      if (!(await Sharing.isAvailableAsync())) throw new Error('这台手机不支持分享文件');
      await Sharing.shareAsync(f.uri, { mimeType: 'text/plain', dialogTitle: '发送日志' });
    } catch (e) {
      appLog('warn', '分享日志失败：', e);
      setResult({ ok: false, text: `分享失败：${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  };

  const saveToPc = async () => {
    const client = getClient();
    if (!client) return;
    setBusy('pc');
    setResult(null);
    try {
      const f = writeLogFile(connectionLines());
      const r = await uploadToPcDetailed(client, { kind: 'file', id: `log_${Date.now()}`, uri: f.uri, name: f.name, size: f.size ?? 0, mimeType: 'text/plain' });
      // 电脑确认收完才提示
      setResult({ ok: true, text: `已存到电脑：${r.path}` });
    } catch (e) {
      appLog('warn', '日志存到电脑失败：', e);
      setResult({ ok: false, text: `存到电脑失败：${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen title="关于">
      <View className="items-center gap-1.5 py-3">
        <Image source={require('../../../assets/images/icon.png')} style={{ width: 64, height: 64, borderRadius: 16 }} />
        <Text className="text-base font-semibold">p2d</Text>
        <Text className="text-xs text-muted-foreground">{`版本 ${appVersion()} · ${deviceLabel()}`}</Text>
      </View>

      <AppUpdate />

      <GroupTitle className="mt-2">导出日志</GroupTitle>
      <Card>
        <Pressable onPress={() => void share()} disabled={!!busy} className="flex-row items-center gap-3 px-3 py-3 active:bg-muted">
          <Icon as={Share2} size={16} className="text-muted-foreground" />
          <View className="flex-1">
            <Text className="text-sm">分享日志文件</Text>
            <Text className="text-xs text-muted-foreground">发到微信、QQ、邮件，或保存到文件</Text>
          </View>
          {busy === 'share' ? <ActivityIndicator size="small" /> : <Icon as={ChevronRight} size={16} className="text-muted-foreground" />}
        </Pressable>
        <Separator />
        <Pressable
          onPress={() => void saveToPc()}
          disabled={!!busy || status !== 'connected'}
          className="flex-row items-center gap-3 px-3 py-3 active:bg-muted"
        >
          <Icon as={Monitor} size={16} className="text-muted-foreground" />
          <View className="flex-1">
            <Text className={status === 'connected' ? 'text-sm' : 'text-sm text-muted-foreground'}>存到电脑</Text>
            <Text className="text-xs text-muted-foreground">
              {status === 'connected' ? '保存到电脑的「下载/p2d」' : '连上电脑后可用'}
            </Text>
          </View>
          {busy === 'pc' ? <ActivityIndicator size="small" /> : <Icon as={FileDown} size={16} className="text-muted-foreground" />}
        </Pressable>
        {result ? (
          <>
            <Separator />
            <Text selectable className={result.ok ? 'px-3 py-2.5 text-xs text-muted-foreground' : 'px-3 py-2.5 text-xs text-destructive'}>
              {result.text}
            </Text>
          </>
        ) : null}
      </Card>
      <Text className="px-1 text-xs text-muted-foreground">
        日志记录连接过程、执行出错和 App 异常退出的原因，不含对话内容、API key 和连接令牌。出了问题时导出，连同问题描述一起发到项目主页的 Issues。
      </Text>

      <GroupTitle className="mt-2">项目主页</GroupTitle>
      <Card>
        <Pressable onPress={() => void Linking.openURL(REPO_URL)} className="flex-row items-center gap-3 px-3 py-3 active:bg-muted">
          <Icon as={GitBranch} size={16} className="text-muted-foreground" />
          <View className="flex-1">
            <Text className="text-sm">GitHub</Text>
            <Text numberOfLines={1} className="text-xs text-muted-foreground">
              {REPO_URL.replace(/^https:\/\//, '')}
            </Text>
          </View>
          <Icon as={ExternalLink} size={16} className="text-muted-foreground" />
        </Pressable>
      </Card>
    </Screen>
  );
}
