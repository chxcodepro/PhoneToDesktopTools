// 添加电脑：扫电脑端「配对新手机」的二维码，或输入电脑 IP 后核对配对码。

import { CameraView, useCameraPermissions } from 'expo-camera';
import { CheckCircle2, Keyboard, QrCode } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, TextInput, View } from 'react-native';

import { parsePairUrl, type PairLink } from '@/protocol/deepLink';
import { deviceLabel, getDevice } from '@/state/devices';
import { connectKnownByAddress, pairByCode, pairByQr, parseAddress } from '@/state/pairing';
import { FieldLabel, Sheet } from '@/components/sheet';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';

type Step = 'choose' | 'scan' | 'ip' | 'code' | 'working' | 'done' | 'error';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 两种添加方式并排的卡片 */
function Choice({ icon, title, onPress }: { icon: typeof QrCode; title: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-1 items-center gap-3 rounded-2xl border border-border bg-card py-6 active:bg-muted"
      accessibilityLabel={title}
    >
      <View className="h-12 w-12 items-center justify-center rounded-full bg-primary/10">
        <Icon as={icon} size={24} className="text-primary" />
      </View>
      <Text className="text-sm font-medium">{title}</Text>
    </Pressable>
  );
}

export function AddPcSheet({ visible, initialLink, onClose }: { visible: boolean; initialLink: PairLink | null; onClose: () => void }) {
  const [step, setStep] = useState<Step>('choose');
  const [ip, setIp] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [donePc, setDonePc] = useState<string | null>(null);
  /** 输入的 IP 是配对过的电脑，直接连上了（没有重新配对） */
  const [reused, setReused] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const resolver = useRef<{ check: (c: string) => boolean; resolve: (c: string | null) => void } | null>(null);
  const scanned = useRef(false);

  /** 只在异步回调里改状态（effect 里也能调用） */
  const pairQr = (link: PairLink) =>
    pairByQr(link).then(
      (pc) => {
        setDonePc(pc);
        setStep('done');
      },
      (e) => {
        setMessage(errText(e));
        setStep('error');
      },
    );

  const runQr = (link: PairLink) => {
    setStep('working');
    setMessage(`正在和「${link.name}」配对…`);
    void pairQr(link);
  };

  // 每次打开时重置；系统相机扫码打开 App 时直接开始配对
  const [lastVisible, setLastVisible] = useState(false);
  if (visible !== lastVisible) {
    setLastVisible(visible);
    if (visible) {
      setStep(initialLink ? 'working' : 'choose');
      setIp('');
      setCode('');
      setCodeError(null);
      setMessage(initialLink ? `正在和「${initialLink.name}」配对…` : '');
    }
  }
  useEffect(() => {
    // 状态已在上面打开时设好，这里只发起配对
    if (visible && initialLink) void pairQr(initialLink);
    // 只在打开时执行一次
  }, [visible, initialLink]);

  const close = () => {
    resolver.current?.resolve(null);
    resolver.current = null;
    onClose();
  };

  const startScan = async () => {
    if (!permission?.granted) {
      const r = await requestPermission();
      if (!r.granted) {
        setMessage('没有相机权限，可以改用「输入电脑 IP」');
        setStep('error');
        return;
      }
    }
    scanned.current = false;
    setStep('scan');
  };

  const startIp = () => {
    const a = parseAddress(ip);
    if (!a) {
      setMessage('请输入电脑的 IP 地址，如 192.168.1.5；用 Tailscale 远程连接时填 100 开头的地址（电脑端窗口里能看到）');
      return;
    }
    setMessage('正在连接电脑…');
    setStep('working');
    setReused(false);
    // 配对过的电脑直接用保存的密钥连接；没配对过才走配对码
    connectKnownByAddress(a.host, a.port)
      .then((pc) => {
        if (!pc) return runPairCode(a.host, a.port);
        setReused(true);
        setDonePc(pc);
        setStep('done');
      })
      .catch((e: unknown) => {
        setMessage(errText(e));
        setStep('error');
      });
  };

  const runPairCode = (host: string, port: number) => {
    setMessage('正在和电脑配对…');
    pairByCode(host, port, (check) => {
      setCode('');
      setCodeError(null);
      setStep('code');
      return new Promise<string | null>((resolve) => {
        resolver.current = { check, resolve };
      });
    }).then(
      (pc) => {
        setDonePc(pc);
        setStep('done');
      },
      (e) => {
        setMessage(errText(e));
        setStep('error');
      },
    );
  };

  const submitCode = () => {
    const r = resolver.current;
    if (!r) return;
    if (!r.check(code)) {
      setCodeError('和电脑上显示的不一致，请再核对一次。如果多次不一致，可能有人在干扰配对，请取消。');
      return;
    }
    resolver.current = null;
    setMessage('正在完成配对…');
    setStep('working');
    r.resolve(code);
  };

  return (
    <Sheet visible={visible} title="添加电脑" onClose={close} fit>
      {step === 'choose' ? (
        <View className="flex-row gap-3">
          <Choice icon={QrCode} title="扫码配对" onPress={() => void startScan()} />
          <Choice icon={Keyboard} title="输入电脑 IP" onPress={() => setStep('ip')} />
        </View>
      ) : null}

      {step === 'scan' ? (
        <>
          <View className="aspect-square w-full overflow-hidden rounded-2xl bg-black">
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={(r) => {
                if (scanned.current) return;
                const link = parsePairUrl(r.data);
                if (!link) return;
                scanned.current = true;
                runQr(link);
              }}
            />
          </View>
          <Button variant="outline" onPress={() => setStep('choose')}>
            <Text>返回</Text>
          </Button>
        </>
      ) : null}

      {step === 'ip' ? (
        <>
          <FieldLabel>电脑 IP 地址</FieldLabel>
          <Input
            value={ip}
            onChangeText={(v) => {
              setIp(v);
              setMessage('');
            }}
            placeholder="如 192.168.1.5，Tailscale 填 100.x.x.x"
            keyboardType="numbers-and-punctuation"
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={startIp}
            autoFocus
          />
          {message ? <Text className="text-xs text-destructive">{message}</Text> : null}
          <View className="flex-row gap-2">
            <Button variant="outline" className="flex-1" onPress={() => setStep('choose')}>
              <Text>返回</Text>
            </Button>
            <Button className="flex-1" onPress={startIp}>
              <Text>下一步</Text>
            </Button>
          </View>
        </>
      ) : null}

      {step === 'code' ? (
        <>
          <Text className="text-sm">电脑上现在显示了一个 6 位配对码，请输入：</Text>
          <TextInput
            value={code}
            onChangeText={(v) => {
              setCode(v.replace(/\D/g, '').slice(0, 6));
              setCodeError(null);
            }}
            keyboardType="number-pad"
            maxLength={6}
            autoFocus
            placeholder="000000"
            placeholderTextColor="#cbd5e1"
            className="h-16 rounded-xl border border-input bg-background text-center font-mono text-3xl tracking-[8px] text-foreground"
            onSubmitEditing={submitCode}
          />
          {codeError ? <Text className="text-xs text-destructive">{codeError}</Text> : null}
          <View className="flex-row gap-2">
            <Button variant="outline" className="flex-1" onPress={close}>
              <Text>取消</Text>
            </Button>
            <Button className="flex-1" disabled={code.length !== 6} onPress={submitCode}>
              <Text>确认</Text>
            </Button>
          </View>
        </>
      ) : null}

      {step === 'working' ? (
        <View className="items-center gap-3 py-10">
          <ActivityIndicator color="#2563eb" />
          <Text className="text-sm text-muted-foreground">{message}</Text>
        </View>
      ) : null}

      {step === 'done' ? (
        <View className="items-center gap-3 py-8">
          <Icon as={CheckCircle2} size={44} className="text-success-foreground" />
          <Text className="text-base font-semibold">
            {reused ? `这台电脑已经配对过，正在连接「${deviceLabel(getDevice(donePc))}」` : `已配对「${deviceLabel(getDevice(donePc))}」`}
          </Text>
          <Button className="w-full" onPress={close}>
            <Text>完成</Text>
          </Button>
        </View>
      ) : null}

      {step === 'error' ? (
        <View className="gap-3 py-4">
          <Text className="text-sm text-destructive">{message}</Text>
          <Button variant="outline" onPress={() => setStep('choose')}>
            <Text>重试</Text>
          </Button>
        </View>
      ) : null}
    </Sheet>
  );
}
