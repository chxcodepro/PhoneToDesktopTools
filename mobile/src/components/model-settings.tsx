// 设置页「模型」部分：OpenAI / DeepSeek / 自定义 预设，API Key 存安全存储。

import { fetch as expoFetch } from 'expo/fetch';
import { Check, Image as ImageIcon, RefreshCw, Wrench } from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card, GroupTitle, Separator } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { chat, configProblem, listModels, type FetchLike } from '@/agent/llm';
import {
  getApiKey,
  initModelConfig,
  resolveActiveModel,
  setActivePreset,
  setApiKey,
  updatePreset,
  useModelConfig,
} from '@/agent/modelConfig';
import { MODEL_PRESETS } from '@/agent/presets';
import { cn } from '@/lib/utils';

const PRESET_OPTIONS = MODEL_PRESETS.map((p) => ({ value: p.id, label: p.label }));
const doFetch = expoFetch as unknown as FetchLike;

type TestState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; text: string } | { kind: 'error'; text: string };

export function ModelSettings() {
  const cfg = useModelConfig();
  useEffect(() => {
    void initModelConfig();
  }, []);
  return (
    <View className="gap-3">
      <GroupTitle className="mt-2">模型</GroupTitle>
      <Segmented value={cfg.active} options={PRESET_OPTIONS} onChange={(v) => void setActivePreset(v)} />
      {/* 切换预设时用 key 重建表单，清空临时输入和测试结果 */}
      <PresetForm key={cfg.active} />
    </View>
  );
}

function PresetForm() {
  const cfg = useModelConfig();
  const id = cfg.active;
  const s = cfg.presets[id];
  const [keyText, setKeyText] = useState('');
  const [models, setModels] = useState<TestState>({ kind: 'idle' });
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  const saveKey = async () => {
    if (keyText.trim()) {
      await setApiKey(id, keyText);
      setKeyText('');
    }
  };

  const fetchModels = async () => {
    await saveKey();
    setModels({ kind: 'busy' });
    try {
      const list = await listModels({ baseUrl: s.baseUrl.trim(), apiKey: await getApiKey(id) }, doFetch);
      await updatePreset(id, { models: list });
      setModels(list.length ? { kind: 'idle' } : { kind: 'error', text: '接口没有返回模型，请手动填写' });
    } catch (e) {
      setModels({ kind: 'error', text: (e as Error).message });
    }
  };

  const runTest = async () => {
    await saveKey();
    const m = await resolveActiveModel(id);
    if (m.problem) {
      setTest({ kind: 'error', text: m.problem });
      return;
    }
    setTest({ kind: 'busy' });
    const started = Date.now();
    try {
      const r = await chat(m.llm, [{ role: 'user', content: '请只回复「好」' }], doFetch);
      const reply = typeof r.message.content === 'string' ? r.message.content.trim() : '';
      setTest({ kind: 'ok', text: `连接成功（${((Date.now() - started) / 1000).toFixed(1)} 秒）${reply ? `：${reply.slice(0, 20)}` : ''}` });
    } catch (e) {
      setTest({ kind: 'error', text: (e as Error).message });
    }
  };

  const baseProblem = configProblem({ baseUrl: s.baseUrl, apiKey: 'x', model: 'x' });

  return (
    <View className="gap-3">
      {id === 'custom' ? (
        <>
          <Field label="名称">
            <Input value={s.name} onChangeText={(v) => void updatePreset(id, { name: v })} placeholder="如：通义千问" />
          </Field>
          <Field label="接口地址">
            <Input
              value={s.baseUrl}
              onChangeText={(v) => void updatePreset(id, { baseUrl: v })}
              placeholder="<YOUR_LLM_BASE_URL>"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </Field>
        </>
      ) : baseProblem ? (
        <Text className="px-1 text-xs text-destructive">预设接口地址尚未配置（presets.ts）</Text>
      ) : null}

      <Field label="API Key">
        <Input
          value={keyText}
          onChangeText={setKeyText}
          onBlur={() => void saveKey()}
          onSubmitEditing={() => void saveKey()}
          placeholder={cfg.hasKey[id] ? '已保存，输入新的可替换' : '<YOUR_API_KEY>'}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>

      <Field
        label="模型"
        right={
          <Pressable onPress={() => void fetchModels()} hitSlop={8} className="flex-row items-center gap-1">
            {models.kind === 'busy' ? (
              <ActivityIndicator size="small" />
            ) : (
              <Icon as={RefreshCw} size={12} className="text-primary" />
            )}
            <Text className="text-xs text-primary">获取列表</Text>
          </Pressable>
        }
      >
        <Input
          value={s.model}
          onChangeText={(v) => void updatePreset(id, { model: v })}
          placeholder="<YOUR_MODEL_NAME>"
          autoCapitalize="none"
          autoCorrect={false}
        />
        {models.kind === 'error' ? <Text className="text-xs text-destructive">{models.text}</Text> : null}
        {s.models.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="gap-2 py-1">
            {s.models.map((m) => (
              <Pressable
                key={m}
                onPress={() => void updatePreset(id, { model: m })}
                className={cn(
                  'flex-row items-center gap-1 rounded-full border px-3 py-1',
                  m === s.model ? 'border-primary bg-primary/10' : 'border-border',
                )}
              >
                {m === s.model ? <Icon as={Check} size={12} className="text-primary" /> : null}
                <Text className={cn('text-xs', m === s.model && 'text-primary')}>{m}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
      </Field>

      <Card>
        <View className="flex-row items-center gap-3 px-3 py-3">
          <Icon as={ImageIcon} size={16} className="text-muted-foreground" />
          <Text className="flex-1 text-sm">支持图片</Text>
          <Switch checked={s.supportsVision} onCheckedChange={(v) => void updatePreset(id, { supportsVision: v })} />
        </View>
        <Separator />
        <View className="flex-row items-center gap-3 px-3 py-3">
          <Icon as={Wrench} size={16} className="text-muted-foreground" />
          <Text className="flex-1 text-sm">支持工具调用</Text>
          <Switch checked={s.supportsTools} onCheckedChange={(v) => void updatePreset(id, { supportsTools: v })} />
        </View>
      </Card>

      <Button variant="outline" onPress={() => void runTest()} disabled={test.kind === 'busy'}>
        {test.kind === 'busy' ? <ActivityIndicator size="small" /> : null}
        <Text>测试连接</Text>
      </Button>
      {test.kind === 'ok' || test.kind === 'error' ? (
        <Text className={cn('px-1 text-xs', test.kind === 'ok' ? 'text-success-foreground' : 'text-destructive')}>
          {test.text}
        </Text>
      ) : null}
    </View>
  );
}

function Field({ label, right, children }: { label: string; right?: ReactNode; children: ReactNode }) {
  return (
    <View className="gap-1.5">
      <View className="flex-row items-center justify-between">
        <Text className="text-xs font-medium">{label}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}
