// MCP 的添加面板和详情面板。

import { Trash2 } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';

import {
  addServers,
  connectServer,
  getSecret,
  removeServer,
  setSecret,
  toggleTool,
  updateServer,
  useExtensions,
} from '@/agent/extensionStore';
import { describeDraft } from '@/agent/extensionTools';
import { parseMcpConfig, type McpServer } from '@/agent/extensions';
import { askConfirm } from '@/components/action-sheet';
import { FieldLabel, Sheet } from '@/components/sheet';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';

const EXAMPLE = `{
  "mcpServers": {
    "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] }
  }
}`;

export function AddMcpSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [config, setConfig] = useState('');
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastVisible, setLastVisible] = useState(visible);
  if (visible !== lastVisible) {
    setLastVisible(visible);
    if (visible) {
      setConfig('');
      setName('');
      setToken('');
      setError(null);
    }
  }

  const parsed = config.trim() ? parseMcpConfig(config, name.trim()) : null;
  const isUrl = /^https?:\/\//i.test(config.trim());

  const save = async () => {
    if (!parsed) return setError('请填写地址或粘贴配置');
    if (typeof parsed === 'string') return setError(parsed);
    const t = token.trim();
    const auth = /^\S+\s+\S+/.test(t) ? t : `Bearer ${t}`;
    const drafts = parsed.map((d) => (t && d.kind === 'remote' ? { ...d, headers: { ...d.headers, Authorization: auth } } : d));
    setBusy(true);
    try {
      await addServers(drafts, 'user');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible={visible} title="添加 MCP" onClose={onClose}>
      <FieldLabel>地址或 JSON 配置</FieldLabel>
      <TextInput
        value={config}
        onChangeText={(v) => {
          setConfig(v);
          setError(null);
        }}
        placeholder={`https://example.com/mcp\n\n或粘贴 mcpServers 配置：\n${EXAMPLE}`}
        placeholderTextColor="#94a3b8"
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        textAlignVertical="top"
        className="min-h-40 rounded-md border border-input bg-background px-3 py-2.5 font-mono text-xs leading-5 text-foreground"
      />
      {isUrl ? (
        <>
          <FieldLabel>名称（可选）</FieldLabel>
          <Input value={name} onChangeText={setName} placeholder="如：高德地图" />
          <FieldLabel>令牌（可选）</FieldLabel>
          <Input
            value={token}
            onChangeText={setToken}
            placeholder="<YOUR_MCP_TOKEN>，作为 Authorization 请求头"
            secureTextEntry
            autoCapitalize="none"
          />
        </>
      ) : null}
      {parsed && typeof parsed !== 'string' ? (
        <View className="gap-1 rounded-lg bg-muted p-3">
          {parsed.map((d) => (
            <Text key={d.name} className="text-xs text-muted-foreground">
              {`「${d.name}」${describeDraft(d)}`}
            </Text>
          ))}
        </View>
      ) : null}
      {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
      <Button onPress={save} disabled={busy}>
        <Text>{busy ? '正在添加…' : '添加'}</Text>
      </Button>
    </Sheet>
  );
}

function SecretField({ server, name }: { server: McpServer; name: string }) {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState<boolean | null>(null);
  // 只显示「已填写 / 未填写」，不把值读到界面上
  useEffect(() => {
    let alive = true;
    void getSecret(server.id, name).then((v) => alive && setSaved(!!v));
    return () => {
      alive = false;
    };
  }, [server.id, name]);
  return (
    <View className="gap-1.5">
      <FieldLabel>{`${name}${saved ? '（已填写）' : saved === false ? '（未填写）' : ''}`}</FieldLabel>
      <View className="flex-row gap-2">
        <Input
          className="flex-1"
          value={value}
          onChangeText={setValue}
          placeholder={
            saved ? '已保存，输入新值可替换' : name.toLowerCase() === 'authorization' ? 'Bearer <YOUR_MCP_TOKEN>' : '<YOUR_TOKEN>'
          }
          secureTextEntry
          autoCapitalize="none"
        />
        <Button
          variant="outline"
          disabled={!value.trim()}
          onPress={async () => {
            await setSecret(server.id, name, value.trim());
            setValue('');
            setSaved(true);
            void connectServer(server.id);
          }}
        >
          <Text>保存</Text>
        </Button>
      </View>
    </View>
  );
}

export function McpDetailSheet({ serverId, onClose }: { serverId: string | null; onClose: () => void }) {
  const { servers, status } = useExtensions();
  const s = servers.find((x) => x.id === serverId);
  const st = s ? status[s.id] : undefined;
  return (
    <Sheet visible={!!s} title={s?.name ?? ''} onClose={onClose}>
      {s ? (
        <>
          <View className="gap-1 rounded-lg bg-muted p-3">
            <Text className="text-xs text-muted-foreground">
              {s.kind === 'remote' ? `远程 MCP · ${s.url}` : `电脑上运行 · ${[s.command, ...(s.args ?? [])].join(' ')}`}
            </Text>
            {st?.error ? <Text className="text-xs text-destructive">{st.error}</Text> : null}
          </View>
          {(s.secrets ?? []).map((n) => (
            <SecretField key={n} server={s} name={n} />
          ))}
          <View className="flex-row items-center">
            <Text className="flex-1 text-sm font-medium">{`工具${st?.tools.length ? `（${st.tools.length}）` : ''}`}</Text>
            <Pressable onPress={() => void connectServer(s.id)} hitSlop={8}>
              <Text className="text-sm text-primary">{st?.state === 'connecting' ? '连接中…' : '重新连接'}</Text>
            </Pressable>
          </View>
          {st?.tools.length ? (
            st.tools.map((t) => (
              <View key={t.name} className="flex-row items-center gap-3 border-b border-border pb-2">
                <View className="flex-1">
                  <Text className="font-mono text-xs">{t.name}</Text>
                  {t.description ? (
                    <Text numberOfLines={2} className="text-xs text-muted-foreground">
                      {t.description}
                    </Text>
                  ) : null}
                </View>
                <Switch checked={!s.disabledTools.includes(t.name)} onCheckedChange={(v) => toggleTool(s.id, t.name, v)} />
              </View>
            ))
          ) : (
            <Text className="text-xs text-muted-foreground">
              {st?.state === 'offline' ? '电脑未连接，连上后自动启动' : st?.state === 'connecting' ? '正在获取工具列表…' : '暂无工具'}
            </Text>
          )}
          <View className="flex-row items-center gap-3">
            <Text className="flex-1 text-sm">启用</Text>
            <Switch checked={s.enabled} onCheckedChange={(v) => updateServer(s.id, { enabled: v })} />
          </View>
          <Button
            variant="outline"
            onPress={() =>
              askConfirm({ title: '删除这个 MCP？', message: `「${s.name}」`, icon: Trash2 }, () => {
                onClose();
                void removeServer(s.id);
              })
            }
          >
            <Icon as={Trash2} size={15} className="text-destructive" />
            <Text className="text-destructive">删除</Text>
          </Button>
        </>
      ) : null}
    </Sheet>
  );
}
