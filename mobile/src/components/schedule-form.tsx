// 新建 / 编辑定时任务的表单（从底部弹出）。

import { X } from 'lucide-react-native';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';

import { parseScheduleArgs, type ScheduledTask, type ScheduleKind } from '@/agent/schedule';
import { createTask, updateTask } from '@/agent/scheduler';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

const KINDS = [
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'interval', label: '间隔' },
  { value: 'once', label: '一次' },
] as const satisfies readonly { value: ScheduleKind; label: string }[];

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const INTERVALS = [
  { label: '30 分钟', value: 30 },
  { label: '1 小时', value: 60 },
  { label: '2 小时', value: 120 },
  { label: '6 小时', value: 360 },
];

const pad = (n: number) => String(n).padStart(2, '0');

function tomorrow(): string {
  const d = new Date(Date.now() + 86_400_000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function initial(task: ScheduledTask | null) {
  const at = task?.at ? new Date(task.at) : null;
  return {
    name: task?.name ?? '',
    prompt: task?.prompt ?? '',
    kind: (task?.kind ?? 'daily') as ScheduleKind,
    time: task?.time ?? (at ? `${pad(at.getHours())}:${pad(at.getMinutes())}` : '08:00'),
    date: at ? `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` : tomorrow(),
    weekdays: task?.weekdays ?? [1, 2, 3, 4, 5],
    interval: String(task?.intervalMin ?? 60),
  };
}

function Label({ children }: { children: string }) {
  return <Text className="text-xs font-medium">{children}</Text>;
}

/** task 为 null 时新建，否则编辑 */
export function ScheduleForm({ visible, task, onClose }: { visible: boolean; task: ScheduledTask | null; onClose: () => void }) {
  const [f, setF] = useState(() => initial(task));
  const [error, setError] = useState<string | null>(null);
  // 每次打开时按传入的任务重置表单（渲染期间按 key 调整状态，不用 effect）
  const formKey = `${visible}-${task?.id ?? 'new'}`;
  const [lastKey, setLastKey] = useState(formKey);
  if (formKey !== lastKey) {
    setLastKey(formKey);
    setF(initial(task));
    setError(null);
  }
  const set = (patch: Partial<typeof f>) => setF((cur) => ({ ...cur, ...patch }));

  const save = () => {
    if (!f.name.trim()) return setError('请填写名称');
    if (!f.prompt.trim()) return setError('请填写到点后要让 Agent 做什么');
    const input = parseScheduleArgs({
      name: f.name,
      prompt: f.prompt,
      kind: f.kind,
      datetime: `${f.date} ${f.time}`,
      time: f.time,
      weekdays: f.weekdays,
      interval_minutes: Number(f.interval),
    });
    if (typeof input === 'string') {
      // 参数说明是写给模型的，这里换成表单上的说法
      setError(
        input
          .replace(/^once 需要 datetime.*$/, '请按「2026-11-21」和「08:00」的格式填写日期和时间')
          .replace(/^(daily|weekly) 需要 time.*$/, '请按「08:00」的格式填写时间')
          .replace(/^weekly 需要 weekdays.*$/, '请至少选择一天')
          .replace(/^interval 需要 interval_minutes，/, '间隔'),
      );
      return;
    }
    if (task) {
      // 换周期类型时清掉旧类型的字段
      updateTask(task.id, { at: undefined, time: undefined, weekdays: undefined, intervalMin: undefined, ...input, enabled: true });
    } else createTask(input, 'user');
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="h-[8%] bg-black/40" onPress={onClose} />
      <SafeAreaView edges={['bottom']} className="flex-1 rounded-t-3xl bg-background">
        <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
          <View className="flex-row items-center px-4 pb-2 pt-4">
            <Text className="flex-1 text-base font-semibold">{task ? '编辑定时任务' : '新建定时任务'}</Text>
            <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="关闭">
              <Icon as={X} size={18} className="text-muted-foreground" />
            </Pressable>
          </View>
          <ScrollView contentContainerClassName="gap-3 px-4 pb-6" keyboardShouldPersistTaps="handled">
            <Label>名称</Label>
            <Input value={f.name} onChangeText={(v) => set({ name: v })} placeholder="如：每日电脑体检" />

            <Label>到点后让 Agent 做什么</Label>
            <TextInput
              value={f.prompt}
              onChangeText={(v) => set({ prompt: v })}
              placeholder="如：给电脑做一次体检，只查看不修改，有问题按严重程度列出来"
              placeholderTextColor="#94a3b8"
              multiline
              textAlignVertical="top"
              className="min-h-24 rounded-md border border-input bg-background px-3 py-2.5 text-sm leading-5 text-foreground"
            />

            <Label>周期</Label>
            <Segmented value={f.kind} options={KINDS} onChange={(v) => set({ kind: v })} />

            {f.kind === 'weekly' ? (
              <View className="flex-row justify-between">
                {WEEKDAYS.map((w, i) => {
                  const d = i + 1;
                  const on = f.weekdays.includes(d);
                  return (
                    <Pressable
                      key={w}
                      onPress={() => set({ weekdays: on ? f.weekdays.filter((x) => x !== d) : [...f.weekdays, d] })}
                      className={cn(
                        'h-10 w-10 items-center justify-center rounded-full border',
                        on ? 'border-primary bg-primary' : 'border-border',
                      )}
                    >
                      <Text className={cn('text-sm', on && 'text-primary-foreground')}>{w}</Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}

            {f.kind === 'once' ? (
              <View className="flex-row gap-2">
                <View className="flex-1 gap-1.5">
                  <Label>日期</Label>
                  <Input
                    value={f.date}
                    onChangeText={(v) => set({ date: v })}
                    placeholder="2026-11-21"
                    keyboardType="numbers-and-punctuation"
                  />
                </View>
                <View className="w-28 gap-1.5">
                  <Label>时间</Label>
                  <Input value={f.time} onChangeText={(v) => set({ time: v })} placeholder="08:00" keyboardType="numbers-and-punctuation" />
                </View>
              </View>
            ) : f.kind === 'interval' ? (
              <View className="gap-1.5">
                <Label>间隔（分钟，不少于 15）</Label>
                <Input value={f.interval} onChangeText={(v) => set({ interval: v.replace(/[^0-9]/g, '') })} keyboardType="number-pad" />
                <View className="flex-row gap-2">
                  {INTERVALS.map((it) => (
                    <Pressable
                      key={it.value}
                      onPress={() => set({ interval: String(it.value) })}
                      className={cn(
                        'rounded-full border px-3 py-1',
                        f.interval === String(it.value) ? 'border-primary bg-primary/10' : 'border-border',
                      )}
                    >
                      <Text className={cn('text-xs', f.interval === String(it.value) && 'text-primary')}>{it.label}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : (
              <View className="gap-1.5">
                <Label>时间</Label>
                <Input value={f.time} onChangeText={(v) => set({ time: v })} placeholder="08:00" keyboardType="numbers-and-punctuation" />
              </View>
            )}

            {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
            <Button onPress={save}>
              <Text>保存</Text>
            </Button>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
