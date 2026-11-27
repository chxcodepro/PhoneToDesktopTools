// Agent 输入区：上面是文字输入，下面一行是附件按钮（图片 / 拍照 / 文件）、思考程度、上下文圆环和发送 / 停止按钮。

import { Image } from 'expo-image';
import { ArrowUp, Atom, Camera, FileText, ImageIcon, Paperclip, Plus, Square, X } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';
import Animated, { FadeInDown, FadeOut } from 'react-native-reanimated';

import { formatSize, pickFiles, pickImages, takePhoto, type Attachment } from '@/agent/attachments';
import { reasoningLabel, type ReasoningLevel, type ReasoningOption } from '@/agent/reasoning';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

const MAX_ATTACHMENTS = 9;

function PendingAttachment({ att, onRemove }: { att: Attachment; onRemove: () => void }) {
  return (
    <View className="relative">
      {att.kind === 'image' ? (
        <Image source={{ uri: att.uri }} style={{ width: 56, height: 56, borderRadius: 8 }} contentFit="cover" />
      ) : (
        <View className="h-14 w-36 flex-row items-center gap-2 rounded-lg border border-border bg-muted px-2">
          <Icon as={FileText} size={18} className="text-muted-foreground" />
          <View className="flex-1">
            <Text numberOfLines={1} className="text-xs font-medium">
              {att.name}
            </Text>
            <Text className="text-[10px] text-muted-foreground">{formatSize(att.size)}</Text>
          </View>
        </View>
      )}
      <Pressable
        onPress={onRemove}
        hitSlop={8}
        className="absolute -right-1.5 -top-1.5 h-5 w-5 items-center justify-center rounded-full bg-foreground"
      >
        <Icon as={X} size={12} className="text-background" />
      </Pressable>
    </View>
  );
}

function MenuButton({ icon, label, onPress }: { icon: typeof Plus; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} className="flex-1 items-center gap-1 rounded-xl border border-border bg-background py-2.5 active:bg-muted">
      <Icon as={icon} size={20} className="text-foreground" />
      <Text className="text-xs">{label}</Text>
    </Pressable>
  );
}

export function Composer({
  running,
  onSend,
  onStop,
  onError,
  reasoning,
  reasoningOptions,
  onReasoning,
  accessory,
  draft,
}: {
  running: boolean;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onError: (message: string) => void;
  /** 思考程度；null 表示当前模型不能调，不显示按钮 */
  reasoning: ReasoningLevel | null;
  /** 能选的档位，从快到强 */
  reasoningOptions: ReasoningOption[];
  onReasoning: (level: ReasoningLevel) => void;
  /** 发送按钮左边的附加内容（上下文圆环） */
  accessory?: ReactNode;
  /** 通过链接带进来的文字，填入输入框（不自动发送） */
  draft?: { text: string; seq: number } | null;
}) {
  const [text, setText] = useState('');
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [menu, setMenu] = useState(false);
  const [effortMenu, setEffortMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  // 收到新的草稿时填入（渲染期间按 seq 调整状态，不用 effect）
  const [draftSeq, setDraftSeq] = useState<number | null>(null);
  if (draft && draft.seq !== draftSeq) {
    setDraftSeq(draft.seq);
    setText(draft.text);
  }

  const add = async (pick: () => Promise<Attachment[]>) => {
    setMenu(false);
    setBusy(true);
    try {
      const picked = await pick();
      setAtts((cur) => [...cur, ...picked].slice(0, MAX_ATTACHMENTS));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canSend = !running && !busy && (text.trim().length > 0 || atts.length > 0);
  const submit = () => {
    if (!canSend) return;
    onSend(text, atts);
    setText('');
    setAtts([]);
  };

  return (
    <View className="gap-2 px-3 pb-2 pt-1">
      {menu ? (
        <Animated.View entering={FadeInDown.duration(180)} exiting={FadeOut.duration(120)} style={{ flexDirection: 'row', gap: 8 }}>
          <MenuButton icon={ImageIcon} label="图片" onPress={() => void add(() => pickImages(MAX_ATTACHMENTS - atts.length))} />
          <MenuButton icon={Camera} label="拍照" onPress={() => void add(takePhoto)} />
          <MenuButton icon={Paperclip} label="文件" onPress={() => void add(pickFiles)} />
        </Animated.View>
      ) : null}
      {effortMenu && reasoning !== null ? (
        <Animated.View entering={FadeInDown.duration(180)} exiting={FadeOut.duration(120)} className="rounded-2xl border border-border bg-background p-2 shadow-sm">
          <View className="flex-row items-center justify-between px-1 pb-1.5">
            <Text className="text-[13px] font-medium">思考程度</Text>
            <Text className="text-[11px] text-muted-foreground">{reasoningOptions.find((o) => o.id === reasoning)?.hint ?? ''}</Text>
          </View>
          <View className="flex-row gap-1 rounded-xl bg-muted p-1">
            {reasoningOptions.map((o) => (
              <Pressable
                key={o.id}
                onPress={() => {
                  onReasoning(o.id);
                  setEffortMenu(false);
                }}
                accessibilityRole="radio"
                accessibilityState={{ checked: o.id === reasoning }}
                className={cn('h-8 flex-1 items-center justify-center rounded-lg', o.id === reasoning && 'bg-background shadow-sm')}
              >
                <Text className={cn('text-[13px]', o.id === reasoning ? 'font-medium text-primary' : 'text-muted-foreground')}>{o.label}</Text>
              </Pressable>
            ))}
          </View>
          <View className="flex-row justify-between px-1 pt-1">
            <Text className="text-[10px] text-muted-foreground">更快</Text>
            <Text className="text-[10px] text-muted-foreground">更强</Text>
          </View>
        </Animated.View>
      ) : null}

      <View className="rounded-[28px] border border-border bg-background shadow-sm">
        {atts.length || busy ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerClassName="gap-2 px-4 pt-3">
            {atts.map((a) => (
              <PendingAttachment key={a.id} att={a} onRemove={() => setAtts((cur) => cur.filter((x) => x.id !== a.id))} />
            ))}
            {busy ? (
              <View className="h-14 w-14 items-center justify-center rounded-lg bg-muted">
                <ActivityIndicator size="small" />
              </View>
            ) : null}
          </ScrollView>
        ) : null}

        <TextInput
          value={text}
          onChangeText={setText}
          onFocus={() => {
            setMenu(false);
            setEffortMenu(false);
          }}
          placeholder="让电脑做点什么…"
          placeholderTextColor="#94a3b8"
          multiline
          textAlignVertical="center"
          className="mx-4 mt-2.5 max-h-32 min-h-9 py-0 text-[15px] text-foreground"
        />

        <View className="flex-row items-center gap-2 px-2.5 pb-2.5 pt-1">
          <Pressable
            onPress={() => {
              setEffortMenu(false);
              setMenu((v) => !v);
            }}
            className={cn('h-9 w-9 items-center justify-center rounded-full border border-border', menu && 'bg-muted')}
            hitSlop={4}
            accessibilityLabel="添加附件"
          >
            <Icon as={menu ? X : Plus} size={18} className="text-foreground" />
          </Pressable>
          {reasoning !== null ? (
            <Pressable
              onPress={() => {
                setMenu(false);
                setEffortMenu((v) => !v);
              }}
              accessibilityLabel={`思考程度：${reasoningLabel(reasoning)}`}
              className={cn(
                'h-9 flex-row items-center gap-1.5 rounded-full border px-3',
                reasoning !== 'off' ? 'border-primary/30 bg-primary/10' : 'border-border bg-background',
                effortMenu && 'opacity-80',
              )}
            >
              <Icon as={Atom} size={15} className={reasoning !== 'off' ? 'text-primary' : 'text-muted-foreground'} />
              <Text className={cn('text-[13px]', reasoning !== 'off' ? 'text-primary' : 'text-muted-foreground')}>{`思考·${reasoningLabel(reasoning)}`}</Text>
            </Pressable>
          ) : null}
          <View className="flex-1" />
          {accessory}
          {running ? (
            <Pressable
              onPress={onStop}
              className="h-9 w-9 items-center justify-center rounded-full bg-foreground"
              accessibilityLabel="停止"
            >
              <Icon as={Square} size={12} className="text-background" fill="currentColor" />
            </Pressable>
          ) : (
            <Pressable
              onPress={submit}
              disabled={!canSend}
              className={cn('h-9 w-9 items-center justify-center rounded-full bg-primary', !canSend && 'opacity-40')}
              accessibilityLabel="发送"
            >
              <Icon as={ArrowUp} size={18} className="text-primary-foreground" />
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}
