// 定时任务页：列出所有定时任务（用户新建的和 Agent 创建的），可启用 / 停用、立即运行、编辑、删除。

import { router } from 'expo-router';
import { AlarmClock, Bot, Pencil, Play, Plus, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { Alert, Pressable, View } from 'react-native';

import { openConversation, useConversation } from '@/agent/conversations';
import { describeSchedule, formatDateTime, type ScheduledTask } from '@/agent/schedule';
import { deleteTask, runTask, updateTask, useSchedules } from '@/agent/scheduler';
import { ScheduleForm } from '@/components/schedule-form';
import { Screen } from '@/components/screen';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useConnection } from '@/state/connection';

const STATUS: Record<string, { text: string; cls: string }> = {
  running: { text: '执行中', cls: 'text-primary' },
  ok: { text: '成功', cls: 'text-success-foreground' },
  error: { text: '失败', cls: 'text-destructive' },
  missed: { text: '错过', cls: 'text-warning-foreground' },
};

function Action({ icon, label, onPress, disabled }: { icon: typeof Play; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      className={cn('flex-row items-center gap-1 py-1', disabled && 'opacity-40')}
    >
      <Icon as={icon} size={13} className="text-muted-foreground" />
      <Text className="text-xs text-muted-foreground">{label}</Text>
    </Pressable>
  );
}

function TaskCard({ t, onEdit }: { t: ScheduledTask; onEdit: () => void }) {
  const { running } = useConversation();
  const { status } = useConnection();
  const st = t.lastStatus ? STATUS[t.lastStatus] : null;
  return (
    <Card className="gap-2 p-3">
      <View className="flex-row items-center gap-2">
        <Icon as={AlarmClock} size={16} className={t.enabled ? 'text-primary' : 'text-muted-foreground'} />
        <Text numberOfLines={1} className={cn('flex-1 font-medium', !t.enabled && 'text-muted-foreground')}>
          {t.name}
        </Text>
        {t.createdBy === 'agent' ? <Icon as={Bot} size={13} className="text-muted-foreground" /> : null}
        <Switch checked={t.enabled} onCheckedChange={(v) => updateTask(t.id, { enabled: v })} />
      </View>
      <Text className="text-sm">{describeSchedule(t)}</Text>
      <Text numberOfLines={2} className="text-xs text-muted-foreground">
        {t.prompt}
      </Text>
      <View className="flex-row flex-wrap gap-x-3">
        <Text className="text-xs text-muted-foreground">
          {t.enabled ? `下次：${t.nextRunAt ? formatDateTime(t.nextRunAt) : '无'}` : '已停用'}
        </Text>
        {t.lastRunAt ? (
          <Pressable
            disabled={!t.lastConversationId}
            onPress={() => {
              if (!t.lastConversationId) return;
              void openConversation(t.lastConversationId);
              router.back();
            }}
          >
            <Text className="text-xs text-muted-foreground">
              {`上次：${formatDateTime(t.lastRunAt)} `}
              {st ? <Text className={cn('text-xs', st.cls)}>{st.text}</Text> : null}
              {t.lastConversationId ? <Text className="text-xs text-primary"> 查看</Text> : null}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {t.lastStatus === 'error' || t.lastStatus === 'missed' ? (
        <Text numberOfLines={2} className="text-xs text-muted-foreground">
          {t.lastNote}
        </Text>
      ) : null}
      <View className="flex-row gap-4 border-t border-border pt-2">
        <Action
          icon={Play}
          label="立即运行"
          disabled={running || status !== 'connected'}
          onPress={() => {
            router.back();
            void runTask(t.id);
          }}
        />
        <Action icon={Pencil} label="编辑" onPress={onEdit} />
        <Action
          icon={Trash2}
          label="删除"
          onPress={() =>
            Alert.alert('删除定时任务？', `「${t.name}」`, [
              { text: '取消', style: 'cancel' },
              { text: '删除', style: 'destructive', onPress: () => deleteTask(t.id) },
            ])
          }
        />
      </View>
    </Card>
  );
}

export default function SchedulesScreen() {
  const { tasks } = useSchedules();
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const open = (t: ScheduledTask | null) => {
    setEditing(t);
    setFormOpen(true);
  };
  return (
    <Screen
      title="定时任务"
      right={
        <Pressable onPress={() => open(null)} hitSlop={8} className="flex-row items-center gap-1" accessibilityLabel="新建定时任务">
          <Icon as={Plus} size={16} className="text-primary" />
          <Text className="text-sm text-primary">新建</Text>
        </Pressable>
      }
    >
      {tasks.length === 0 ? (
        <View className="items-center gap-2 py-16">
          <Icon as={AlarmClock} size={32} className="text-muted-foreground" />
          <Text className="text-sm text-muted-foreground">还没有定时任务</Text>
        </View>
      ) : (
        tasks.map((t) => <TaskCard key={t.id} t={t} onEdit={() => open(t)} />)
      )}
      <ScheduleForm visible={formOpen} task={editing} onClose={() => setFormOpen(false)} />
    </Screen>
  );
}
