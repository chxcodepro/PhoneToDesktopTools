// 添加电脑：扫电脑端「配对新手机」的二维码，或输入电脑 IP 后核对配对码。

import { CameraView, useCameraPermissions } from 'expo-camera';
import { CheckCircle2, Keyboard, QrCode } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, TextInput, View } from 'react-native';

import { parsePairUrl, type PairLink } from '@/protocol/deepLink';
import { deviceLabel, getDevice } from '@/state/devices';
import { pairByCode, pairByQr, parseAddress } from '@/state/pairing';
import { FieldLabel, Sheet } from '@/components/sheet';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';

type Step = 'choose' | 'scan' | 'ip' | 'code' | 'working' | 'done' | 'error';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Choice({ icon, title, desc, onPress }: { icon: typeof QrCode; title: string; desc: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} className="flex-row items-center gap-3 rounded-xl border border-border p-3.5 active:bg-muted">
      <Icon as={icon} size={22} className="text-primary" />
      <View className="flex-1">
        <Text className="text-sm font-medium">{title}</Text>
        <Text className="text-xs text-muted-foreground">{desc}</Text>
      </View>
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
      setMessage('请输入电脑的 IP 地址，如 192.168.1.5（电脑端窗口里能看到）');
      return;
    }
    setMessage('正在连接电脑…');
    setStep('working');
    pairByCode(a.host, a.port, (check) => {
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
    <Sheet visible={visible} title="添加电脑" onClose={close}>
      {step === 'choose' ? (
        <>
          <Text className="text-xs text-muted-foreground">先在电脑端窗口点「配对新手机（WiFi）」，然后选一种方式：</Text>
          <Choice icon={QrCode} title="扫码配对" desc="扫电脑端窗口上的二维码" onPress={() => void startScan()} />
          <Choice
            icon={Keyboard}
            title="输入电脑 IP"
            desc="输入电脑端显示的地址，再输入电脑上出现的 6 位配对码"
            onPress={() => setStep('ip')}
          />
          <Text className="text-xs text-muted-foreground">
            用数据线连过的电脑会自动配对，不用再添加。手机和电脑需要在同一个 WiFi / 局域网。
          </Text>
        </>
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
          <Text className="text-center text-xs text-muted-foreground">对准电脑端窗口上的二维码</Text>
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
            placeholder="如 192.168.1.5"
            keyboardType="numbers-and-punctuation"
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={startIp}
            autoFocus
          />
          <Text className="text-xs text-muted-foreground">
            地址在电脑端窗口「配对新手机」里能看到；端口默认 39272，改过的话写成「IP:端口」。
          </Text>
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
          <Text className="text-base font-semibold">{`已配对「${deviceLabel(getDevice(donePc))}」`}</Text>
          <Text className="text-center text-xs text-muted-foreground">
            正在通过 WiFi 连接。以后在同一局域网内，在「设备」里点这台电脑就能直接连。
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
