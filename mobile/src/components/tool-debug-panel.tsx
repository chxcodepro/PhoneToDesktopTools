// 开发调试面板（仅 __DEV__ 显示）：列出电脑端工具，手动填参数调用并查看结果。

import { Play, RefreshCw } from 'lucide-react-native';
import { useState } from 'react';
import { Image, Pressable, ScrollView, View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, GroupTitle } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import type { ToolInfo, ToolResult } from '@/protocol/types';
import { getClient, refreshTools, useConnection } from '@/state/connection';

/** 根据 inputSchema 生成参数模板（只填必填项） */
function argsTemplate(tool: ToolInfo): string {
  const schema = tool.inputSchema as { properties?: Record<string, { type?: string }>; required?: string[] };
  const out: Record<string, unknown> = {};
  for (const key of schema?.required ?? []) {
    const t = schema.properties?.[key]?.type;
    out[key] = t === 'number' || t === 'integer' ? 0 : t === 'boolean' ? false : '';
  }
  return JSON.stringify(out, null, 2);
}

export function ToolDebugPanel() {
  const { tools, status } = useConnection();
  const [selected, setSelected] = useState<string | null>(null);
  const [args, setArgs] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ToolResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tool = tools.find((t) => t.name === selected) ?? null;

  const pick = (t: ToolInfo) => {
    setSelected(t.name);
    setArgs(argsTemplate(t));
    setResult(null);
    setError(null);
  };

  const call = async () => {
    const c = getClient();
    if (!c || !tool) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = args.trim() ? JSON.parse(args) : {};
    } catch {
      setError('参数不是合法的 JSON');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await c.callTool(tool.name, parsed));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="gap-3">
        <View className="flex-row items-center justify-between">
          <Text className="font-semibold">工具调试（仅开发版）</Text>
          <Button
            variant="ghost"
            size="sm"
            disabled={status !== 'connected'}
            onPress={() => void refreshTools().catch(() => undefined)}>
            <Icon as={RefreshCw} size={14} />
            <Text>刷新</Text>
          </Button>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2">
          {tools.map((t) => (
            <Pressable
              key={t.name}
              onPress={() => pick(t)}
              className={cn(
                'rounded-full border px-3 py-1',
                t.name === selected ? 'border-primary bg-primary/10' : 'border-border',
              )}>
              <Text className={cn('font-mono text-xs', t.name === selected && 'text-primary')}>{t.name}</Text>
            </Pressable>
          ))}
          {tools.length === 0 ? <Text className="text-xs text-muted-foreground">没有可用工具</Text> : null}
        </ScrollView>

        {tool ? (
          <View className="gap-2">
            {tool.description ? <Text className="text-xs text-muted-foreground">{tool.description}</Text> : null}
            <GroupTitle>参数（JSON）</GroupTitle>
            <Input
              multiline
              value={args}
              onChangeText={setArgs}
              autoCapitalize="none"
              autoCorrect={false}
              className="h-auto min-h-24 py-2 font-mono text-xs"
              textAlignVertical="top"
            />
            <Button disabled={busy || status !== 'connected'} onPress={() => void call()}>
              <Icon as={Play} size={14} className="text-primary-foreground" />
              <Text>{busy ? '调用中…' : '调用'}</Text>
            </Button>
          </View>
        ) : null}

        {error ? <Text className="text-sm text-destructive">{error}</Text> : null}

        {result ? (
          <View className="gap-2">
            <Badge variant={result.isError ? 'destructive' : 'success'}>
              <Text>{result.isError ? '执行失败' : '执行成功'}</Text>
            </Badge>
            {result.content.map((c, i) =>
              c.type === 'text' ? (
                <Text key={i} selectable className="rounded-md bg-muted p-2 font-mono text-xs">
                  {c.text}
                </Text>
              ) : (
                <Image
                  key={i}
                  source={{ uri: `data:${c.mimeType};base64,${c.data}` }}
                  className="w-full rounded-md"
                  style={{ aspectRatio: 16 / 10 }}
                  resizeMode="contain"
                />
              ),
            )}
          </View>
        ) : null}
      </CardContent>
    </Card>
  );
}
