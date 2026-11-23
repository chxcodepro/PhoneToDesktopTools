// 设置页「模型」部分：OpenAI / DeepSeek / 自定义 预设，API Key 存安全存储。

import { fetch as expoFetch } from 'expo/fetch';
import { Check, ChevronRight, Image as ImageIcon, List, RefreshCw, Wrench } from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, TextInput, View } from 'react-native';

import { ModelPicker } from '@/components/model-picker';
import { Button } from '@/components/ui/button';
import { Card, GroupTitle, Separator } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { defaultContextWindow, formatWindow } from '@/agent/contextWindow';
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
import { PICKER_THRESHOLD } from '@/agent/modelList';
import { MAX_PROMPT, PROMPT_PRESETS, type PromptPreset } from '@/agent/promptPresets';
import { MODEL_PRESETS } from '@/agent/presets';
import { cn } from '@/lib/utils';

/** 上下文长度的常用值；输入框留空时按模型官方数据 */
const WINDOW_PRESETS = [
  { label: '128K', value: 128_000 },
  { label: '256K', value: 256_000 },
  { label: '1M', value: 1_000_000 },
];

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
  const [pickerOpen, setPickerOpen] = useState(false);

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
      setTest({
        kind: 'ok',
        text: `连接成功（${((Date.now() - started) / 1000).toFixed(1)} 秒）${reply ? `：${reply.slice(0, 20)}` : ''}`,
      });
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
            {models.kind === 'busy' ? <ActivityIndicator size="small" /> : <Icon as={RefreshCw} size={12} className="text-primary" />}
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
        {s.models.length > PICKER_THRESHOLD ? (
          // 模型很多时（如 OpenAI 上百个）改用带搜索的选择框
          <>
            <Pressable
              onPress={() => setPickerOpen(true)}
              className="flex-row items-center gap-2 rounded-lg border border-border px-3 py-2.5 active:bg-muted"
            >
              <Icon as={List} size={14} className="text-muted-foreground" />
              <Text className="flex-1 text-sm">{`从 ${s.models.length} 个模型中选择`}</Text>
              <Icon as={ChevronRight} size={16} className="text-muted-foreground" />
            </Pressable>
            <ModelPicker
              visible={pickerOpen}
              models={s.models}
              selected={s.model}
              onSelect={(m) => void updatePreset(id, { model: m })}
              onClose={() => setPickerOpen(false)}
            />
          </>
        ) : s.models.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerClassName="gap-2 py-1">
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

      <Field label="上下文长度">
        <View className="flex-row items-center gap-2">
          <Input
            className="flex-1"
            value={s.contextWindow ? String(Math.round(s.contextWindow / 1000)) : ''}
            onChangeText={(v) => {
              const n = parseInt(v.replace(/[^0-9]/g, ''), 10);
              void updatePreset(id, { contextWindow: n > 0 ? n * 1000 : undefined });
            }}
            placeholder={`默认 ${formatWindow(defaultContextWindow(s.model))}（按模型官方数据）`}
            keyboardType="number-pad"
          />
          <Text className="text-sm text-muted-foreground">K</Text>
        </View>
        {/* 常用长度：点一下填入 */}
        <View className="flex-row gap-2">
          {WINDOW_PRESETS.map((w) => {
            const on = s.contextWindow === w.value;
            return (
              <Pressable
                key={w.label}
                onPress={() => void updatePreset(id, { contextWindow: w.value })}
                className={cn('rounded-full border px-3.5 py-1', on ? 'border-primary bg-primary/10' : 'border-border active:bg-muted')}
              >
                <Text className={cn('text-xs', on && 'font-medium text-primary')}>{w.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </Field>

      <Field
        label="系统提示词"
        right={
          <View className="flex-row items-center gap-3">
            <Text className="text-[11px] text-muted-foreground">{`${(s.systemPrompt ?? '').length} / ${MAX_PROMPT}`}</Text>
            {s.systemPrompt ? (
              <Pressable onPress={() => void updatePreset(id, { systemPrompt: '' })} hitSlop={8}>
                <Text className="text-xs text-muted-foreground">清空</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => choosePreset((text) => void updatePreset(id, { systemPrompt: text }), s.systemPrompt ?? '')}
              hitSlop={8}
            >
              <Text className="text-xs text-primary">使用预设</Text>
            </Pressable>
          </View>
        }
      >
        <TextInput
          value={s.systemPrompt ?? ''}
          onChangeText={(v) => void updatePreset(id, { systemPrompt: v.slice(0, MAX_PROMPT) })}
          placeholder={'例如：回答先给结论再说步骤；改系统设置前先说明风险；称呼我为张工'}
          placeholderTextColor="#94a3b8"
          multiline
          textAlignVertical="top"
          className="min-h-24 max-h-60 rounded-md border border-input bg-background px-3 py-2.5 text-sm leading-5 text-foreground"
        />
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
        <Text className={cn('px-1 text-xs', test.kind === 'ok' ? 'text-success-foreground' : 'text-destructive')}>{test.text}</Text>
      ) : null}
    </View>
  );
}

/** 选择系统提示词预设：只有一个时直接用；当前已有内容时先确认是否替换 */
function choosePreset(apply: (text: string) => void, current: string) {
  const pick = (p: PromptPreset) => {
    if (!current.trim() || current.trim() === p.text.trim()) return apply(p.text);
    Alert.alert(`使用「${p.name}」预设？`, '会替换当前填写的系统提示词。', [
      { text: '取消', style: 'cancel' },
      { text: '替换', onPress: () => apply(p.text) },
    ]);
  };
  if (PROMPT_PRESETS.length === 1) return pick(PROMPT_PRESETS[0]);
  Alert.alert('使用预设', undefined, [
    ...PROMPT_PRESETS.map((p) => ({ text: p.name, onPress: () => pick(p) })),
    { text: '取消', style: 'cancel' as const },
  ]);
}

function Field({ label, right, children }: { label: string; right?: ReactNode; children: ReactNode }) {
  return (
    <View className="gap-1.5">
      <View className="flex-row items-center justify-between">
        <Text className="flex-1 text-xs font-medium">{label}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}
