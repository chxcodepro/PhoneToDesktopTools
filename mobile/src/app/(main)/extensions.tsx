// 扩展页：MCP（远程 / 电脑上运行）和 Skill 的列表、添加、导入、开关。
// 也可以直接在对话里让 Agent 安装（ext_* 工具，会弹确认卡片）。

import { BookOpen, Bot, ChevronRight, Globe, Monitor, Plus, Puzzle } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { setServerEnabled, setSkillEnabled, useExtensions } from '@/agent/extensionStore';
import type { ServerStatus } from '@/agent/extensionTools';
import type { McpServer, Skill } from '@/agent/extensions';
import { AddMcpSheet, McpDetailSheet } from '@/components/extensions/mcp-sheets';
import { ImportSkillSheet, SkillDetailSheet, SkillEditorSheet } from '@/components/extensions/skill-sheets';
import { Screen } from '@/components/screen';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Segmented } from '@/components/ui/segmented';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

type Tab = 'mcp' | 'skill';
const TABS = [
  { value: 'mcp', label: 'MCP' },
  { value: 'skill', label: 'Skill' },
] as const satisfies readonly { value: Tab; label: string }[];

function statusText(s: McpServer, st: ServerStatus | undefined): { text: string; cls: string } {
  if (!s.enabled) return { text: '已停用', cls: 'text-muted-foreground' };
  switch (st?.state) {
    case 'ready':
      return {
        text: `可用 · ${st.tools.length - s.disabledTools.filter((t) => st.tools.some((x) => x.name === t)).length} 个工具`,
        cls: 'text-success-foreground',
      };
    case 'connecting':
      return { text: '连接中…', cls: 'text-primary' };
    case 'error':
      return { text: st.error ?? '出错', cls: 'text-destructive' };
    case 'offline':
      return { text: '电脑未连接，连上后自动启动', cls: 'text-muted-foreground' };
    default:
      return { text: '未连接', cls: 'text-muted-foreground' };
  }
}

function McpCard({ s, st, onOpen }: { s: McpServer; st: ServerStatus | undefined; onOpen: () => void }) {
  const status = statusText(s, st);
  return (
    <Pressable onPress={onOpen}>
      <Card className="flex-row items-center gap-3 p-3">
        <View className="h-9 w-9 items-center justify-center rounded-full bg-muted">
          <Icon as={s.kind === 'remote' ? Globe : Monitor} size={17} className="text-foreground" />
        </View>
        <View className="flex-1 gap-0.5">
          <View className="flex-row items-center gap-1.5">
            <Text numberOfLines={1} className="flex-shrink font-medium">
              {s.name}
            </Text>
            {s.createdBy === 'agent' ? <Icon as={Bot} size={12} className="text-muted-foreground" /> : null}
            <Text className="text-[11px] text-muted-foreground">{s.kind === 'remote' ? '远程' : '电脑'}</Text>
          </View>
          <Text numberOfLines={1} className={cn('text-xs', status.cls)}>
            {status.text}
          </Text>
        </View>
        <Switch checked={s.enabled} onCheckedChange={(v) => setServerEnabled(s.id, v)} />
        <Icon as={ChevronRight} size={16} className="text-muted-foreground" />
      </Card>
    </Pressable>
  );
}

function SkillCard({ s, onOpen }: { s: Skill; onOpen: () => void }) {
  return (
    <Pressable onPress={onOpen}>
      <Card className="flex-row items-center gap-3 p-3">
        <View className="h-9 w-9 items-center justify-center rounded-full bg-muted">
          <Icon as={BookOpen} size={17} className="text-foreground" />
        </View>
        <View className="flex-1 gap-0.5">
          <View className="flex-row items-center gap-1.5">
            <Text numberOfLines={1} className={cn('flex-shrink font-medium', !s.enabled && 'text-muted-foreground')}>
              {s.name}
            </Text>
            {s.createdBy === 'agent' ? <Icon as={Bot} size={12} className="text-muted-foreground" /> : null}
          </View>
          <Text numberOfLines={2} className="text-xs text-muted-foreground">
            {s.description}
          </Text>
        </View>
        <Switch checked={s.enabled} onCheckedChange={(v) => setSkillEnabled(s.id, v)} />
      </Card>
    </Pressable>
  );
}

function Empty({ tab }: { tab: Tab }) {
  return (
    <View className="items-center gap-2 py-14">
      <Icon as={Puzzle} size={32} className="text-muted-foreground" />
      <Text className="text-sm text-muted-foreground">{tab === 'mcp' ? '还没有 MCP 服务' : '还没有 Skill'}</Text>
    </View>
  );
}

export default function ExtensionsScreen() {
  const { servers, skills, status } = useExtensions();
  const [tab, setTab] = useState<Tab>('mcp');
  const [addMcp, setAddMcp] = useState(false);
  const [importSkill, setImportSkill] = useState(false);
  const [editor, setEditor] = useState<{ id: string | null } | null>(null);
  const [mcpId, setMcpId] = useState<string | null>(null);
  const [skillId, setSkillId] = useState<string | null>(null);

  return (
    <Screen
      title="扩展"
      right={
        <Pressable
          onPress={() => (tab === 'mcp' ? setAddMcp(true) : setImportSkill(true))}
          hitSlop={8}
          className="flex-row items-center gap-1"
          accessibilityLabel={tab === 'mcp' ? '添加 MCP' : '导入 Skill'}
        >
          <Icon as={Plus} size={16} className="text-primary" />
          <Text className="text-sm text-primary">添加</Text>
        </Pressable>
      }
    >
      <Segmented value={tab} options={TABS} onChange={setTab} />
      {tab === 'mcp' ? (
        servers.length ? (
          servers.map((s) => <McpCard key={s.id} s={s} st={status[s.id]} onOpen={() => setMcpId(s.id)} />)
        ) : (
          <Empty tab="mcp" />
        )
      ) : skills.length ? (
        skills.map((s) => <SkillCard key={s.id} s={s} onOpen={() => setSkillId(s.id)} />)
      ) : (
        <Empty tab="skill" />
      )}

      <AddMcpSheet visible={addMcp} onClose={() => setAddMcp(false)} />
      <McpDetailSheet serverId={mcpId} onClose={() => setMcpId(null)} />
      <ImportSkillSheet visible={importSkill} onClose={() => setImportSkill(false)} onCreate={() => setEditor({ id: null })} />
      <SkillDetailSheet
        skillId={skillId}
        onClose={() => setSkillId(null)}
        onEdit={(id) => {
          setSkillId(null);
          setEditor({ id });
        }}
      />
      <SkillEditorSheet visible={!!editor} skillId={editor?.id ?? null} onClose={() => setEditor(null)} />
    </Screen>
  );
}
