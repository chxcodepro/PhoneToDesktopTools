// Skill 的导入面板、编辑器和详情面板。

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { FileCode, FilePlus, FolderInput, Link2, Trash2 } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Alert, Pressable, TextInput, View } from 'react-native';

import {
  extensionApi,
  prepareSkillFromText,
  prepareSkillFromZip,
  readSkillText,
  removeSkill,
  saveSkillMd,
  setSkillEnabled,
  useExtensions,
} from '@/agent/extensionStore';
import type { SkillPackage } from '@/agent/extensionTools';
import { formatSize } from '@/agent/attachments';
import { FieldLabel, Sheet } from '@/components/sheet';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';

const TEMPLATE = `---
name: my-skill
description: 一句话说明这个 Skill 做什么、什么时候用
---

# 使用说明

1. 第一步……
2. 第二步……
`;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Choice({ icon, title, desc, onPress }: { icon: typeof Link2; title: string; desc: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} className="flex-row items-center gap-3 rounded-xl border border-border p-3 active:bg-muted">
      <Icon as={icon} size={20} className="text-primary" />
      <View className="flex-1">
        <Text className="text-sm font-medium">{title}</Text>
        <Text className="text-xs text-muted-foreground">{desc}</Text>
      </View>
    </Pressable>
  );
}

export function ImportSkillSheet({ visible, onClose, onCreate }: { visible: boolean; onClose: () => void; onCreate: () => void }) {
  const [url, setUrl] = useState('');
  const [pkg, setPkg] = useState<SkillPackage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastVisible, setLastVisible] = useState(visible);
  if (visible !== lastVisible) {
    setLastVisible(visible);
    if (visible) {
      setUrl('');
      setPkg(null);
      setError(null);
      setBusy(null);
    }
  }

  const pickFile = async () => {
    setError(null);
    const res = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      type: ['application/zip', 'application/x-zip-compressed', 'text/markdown', 'text/plain', '*/*'],
    });
    if (res.canceled) return;
    const a = res.assets[0];
    setBusy('正在读取…');
    try {
      const bytes = await new File(a.uri).bytes();
      setPkg(
        bytes[0] === 0x50 && bytes[1] === 0x4b
          ? prepareSkillFromZip(bytes, a.name)
          : prepareSkillFromText(new TextDecoder().decode(bytes), a.name),
      );
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const fromUrl = async () => {
    if (!/^https?:\/\//i.test(url.trim())) return setError('请填写 http(s) 地址');
    setError(null);
    setBusy('正在下载…');
    try {
      setPkg(await extensionApi.prepareSkillFromUrl(url.trim()));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    if (!pkg) return;
    setBusy('正在安装…');
    try {
      await pkg.commit();
      onClose();
    } catch (e) {
      setError(errText(e));
      setBusy(null);
    }
  };

  return (
    <Sheet visible={visible} title="导入 Skill" onClose={onClose}>
      {pkg ? (
        <>
          <Text className="text-xs text-muted-foreground">{`来源：${pkg.source}`}</Text>
          {pkg.skills.map((s) => {
            const scripts = s.files.filter((f) => /\.(ps1|bat|cmd|sh|py|js|mjs|vbs|exe)$/i.test(f));
            return (
              <View key={s.name} className="gap-1 rounded-xl bg-muted p-3">
                <Text className="text-sm font-semibold">{s.name}</Text>
                <Text className="text-xs text-muted-foreground">{s.description}</Text>
                <Text className="text-xs text-muted-foreground">{`${s.files.length} 个文件`}</Text>
                {scripts.length ? (
                  <Text className="text-xs text-warning-foreground">{`包含脚本（会在电脑上执行）：${scripts.join('、')}`}</Text>
                ) : null}
              </View>
            );
          })}
          {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
          <View className="flex-row gap-2">
            <Button variant="outline" className="flex-1" onPress={() => setPkg(null)}>
              <Text>返回</Text>
            </Button>
            <Button className="flex-1" onPress={install} disabled={!!busy}>
              <Text>{busy ?? '安装'}</Text>
            </Button>
          </View>
        </>
      ) : (
        <>
          <Choice
            icon={FolderInput}
            title="从文件导入"
            desc="选择 .zip 压缩包或 SKILL.md（微信 / QQ 收到的文件也可以）"
            onPress={() => void pickFile()}
          />
          <View className="gap-2 rounded-xl border border-border p-3">
            <View className="flex-row items-center gap-3">
              <Icon as={Link2} size={20} className="text-primary" />
              <View className="flex-1">
                <Text className="text-sm font-medium">从网址导入</Text>
                <Text className="text-xs text-muted-foreground">GitHub 仓库或子目录地址、zip 下载地址、SKILL.md 地址</Text>
              </View>
            </View>
            <View className="flex-row gap-2">
              <Input
                className="flex-1"
                value={url}
                onChangeText={setUrl}
                placeholder="https://github.com/…"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Button variant="outline" onPress={() => void fromUrl()} disabled={!!busy}>
                <Text>获取</Text>
              </Button>
            </View>
          </View>
          <Choice
            icon={FilePlus}
            title="新建"
            desc="自己写 SKILL.md；也可以直接对 Agent 说「把刚才的步骤做成 Skill」"
            onPress={() => {
              onClose();
              onCreate();
            }}
          />
          {busy ? <Text className="text-xs text-muted-foreground">{busy}</Text> : null}
          {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
        </>
      )}
    </Sheet>
  );
}

/** 编辑 SKILL.md；skillId 为 null 时新建 */
export function SkillEditorSheet({ visible, skillId, onClose }: { visible: boolean; skillId: string | null; onClose: () => void }) {
  const [text, setText] = useState(TEMPLATE);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const key = `${visible}-${skillId ?? 'new'}`;
  if (key !== loaded) {
    setLoaded(key);
    setError(null);
    setText(TEMPLATE);
  }
  useEffect(() => {
    if (!visible || !skillId) return;
    let alive = true;
    void readSkillText(skillId).then(
      (t) => alive && setText(t),
      (e) => alive && setError(errText(e)),
    );
    return () => {
      alive = false;
    };
  }, [visible, skillId]);
  const save = async () => {
    try {
      await saveSkillMd(skillId, text);
      onClose();
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <Sheet visible={visible} title={skillId ? '编辑 SKILL.md' : '新建 Skill'} onClose={onClose} scroll={false}>
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        textAlignVertical="top"
        className="flex-1 rounded-md border border-input bg-background px-3 py-2.5 font-mono text-xs leading-5 text-foreground"
      />
      {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
      <Button onPress={() => void save()}>
        <Text>保存</Text>
      </Button>
    </Sheet>
  );
}

export function SkillDetailSheet({
  skillId,
  onClose,
  onEdit,
}: {
  skillId: string | null;
  onClose: () => void;
  onEdit: (id: string) => void;
}) {
  const { skills } = useExtensions();
  const s = skills.find((x) => x.id === skillId);
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);
  const [lastId, setLastId] = useState(skillId);
  if (skillId !== lastId) {
    setLastId(skillId);
    setPreview(null);
  }
  return (
    <Sheet visible={!!s} title={s?.name ?? ''} onClose={onClose}>
      {s ? (
        <>
          <Text className="text-sm">{s.description}</Text>
          <Text className="text-xs text-muted-foreground">{`来源：${s.source ?? '未知'}${s.createdBy === 'agent' ? ' · Agent 创建' : ''}`}</Text>
          <View className="flex-row items-center gap-3">
            <Text className="flex-1 text-sm">启用</Text>
            <Switch checked={s.enabled} onCheckedChange={(v) => setSkillEnabled(s.id, v)} />
          </View>
          <FieldLabel>{`文件（${s.files.length}）`}</FieldLabel>
          {s.files.map((f) => (
            <Pressable
              key={f.path}
              onPress={() => void readSkillText(s.id, f.path).then((t) => setPreview({ path: f.path, text: t }))}
              className="flex-row items-center gap-2 rounded-lg px-1 py-1.5 active:bg-muted"
            >
              <Icon as={FileCode} size={14} className="text-muted-foreground" />
              <Text className="flex-1 font-mono text-xs">{f.path}</Text>
              <Text className="text-xs text-muted-foreground">{formatSize(f.size)}</Text>
            </Pressable>
          ))}
          {preview ? (
            <View className="gap-1 rounded-lg bg-muted p-3">
              <Text className="text-xs font-medium">{preview.path}</Text>
              <Text selectable className="font-mono text-[11px] leading-4 text-muted-foreground">
                {preview.text.length > 6000 ? `${preview.text.slice(0, 6000)}\n…` : preview.text}
              </Text>
            </View>
          ) : null}
          <View className="flex-row gap-2">
            <Button variant="outline" className="flex-1" onPress={() => onEdit(s.id)}>
              <Text>编辑 SKILL.md</Text>
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onPress={() =>
                Alert.alert('删除这个 Skill？', `「${s.name}」`, [
                  { text: '取消', style: 'cancel' },
                  {
                    text: '删除',
                    style: 'destructive',
                    onPress: () => {
                      onClose();
                      void removeSkill(s.id);
                    },
                  },
                ])
              }
            >
              <Icon as={Trash2} size={15} className="text-destructive" />
              <Text className="text-destructive">删除</Text>
            </Button>
          </View>
        </>
      ) : null}
    </Sheet>
  );
}
