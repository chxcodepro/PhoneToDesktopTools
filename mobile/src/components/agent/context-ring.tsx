// 输入框发送按钮左边的上下文圆环：圆环进度 = 上下文用量 / 上限，超过自动压缩阈值时变红。
// 点击弹出 Token 用量卡片（上下文、缓存命中、输出、速度、累计）和「压缩上下文」按钮。
// 键盘弹起时先收起键盘，等输入框落回底部后再量位置，卡片才会紧贴在圆环上方。

import { Database } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { Modal, Pressable, View, useWindowDimensions, type ViewInstance } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';
import Svg, { Circle } from 'react-native-svg';

import { formatWindow } from '@/agent/contextWindow';
import { AUTO_COMPRESS_RATIO, type TurnStats } from '@/agent/conversations';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

const SIZE = 22;
const STROKE = 3;

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

const num = (n: number) => n.toLocaleString('en-US');

function Ring({ ratio, warn }: { ratio: number; warn: boolean }) {
  const r = (SIZE - STROKE) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, ratio));
  return (
    <Svg width={SIZE} height={SIZE}>
      <Circle cx={SIZE / 2} cy={SIZE / 2} r={r} stroke="#e2e8f0" strokeWidth={STROKE} fill="none" />
      {p > 0 ? (
        <Circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={r}
          stroke={warn ? '#ef4444' : '#3b82f6'}
          strokeWidth={STROKE}
          fill="none"
          strokeLinecap="round"
          // 从 12 点方向顺时针画
          strokeDasharray={`${c * Math.max(p, 0.03)} ${c}`}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      ) : null}
    </Svg>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  // 数值列占满剩余宽度并右对齐（内容宽度的 Text 在 Android 上会被少量 1px，导致末尾被截断）
  return (
    <View className="flex-row items-center py-1">
      <Text className="w-16 text-[13px] text-muted-foreground">{label}</Text>
      <Text numberOfLines={1} className={cn('flex-1 text-right text-[13px]', warn && 'text-destructive')}>
        {value}
      </Text>
    </View>
  );
}

const CARD_W = 280;

export function ContextRing({
  model,
  contextWindow,
  stats,
  totalTokens,
  running,
  onCompress,
}: {
  model: string;
  contextWindow: number;
  stats: TurnStats | null;
  totalTokens: number;
  running: boolean;
  onCompress: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ bottom: 0, right: 12 });
  const ref = useRef<ViewInstance>(null);
  const win = useWindowDimensions();

  // 统计来自当前模型时才显示（切换模型后旧数字没有意义）
  const s = stats && stats.model === model ? stats : null;
  const ratio = s ? s.contextTokens / contextWindow : 0;
  const warn = ratio > AUTO_COMPRESS_RATIO;
  const hit = s && s.promptTokens > 0 ? Math.round((s.cachedTokens / s.promptTokens) * 100) : null;

  const show = async () => {
    // 弹窗会让输入框失去焦点、键盘收起；先收好键盘再量，否则卡片会停在键盘还在时的高度
    if (KeyboardController.isVisible()) {
      await KeyboardController.dismiss();
      await new Promise((r) => setTimeout(r, 80));
    }
    ref.current?.measureInWindow((x, y, w) => {
      // 卡片右边与圆环右边对齐，不超出屏幕
      const right = Math.max(12, Math.min(win.width - (x + w), win.width - CARD_W - 12));
      setAnchor({ bottom: win.height - y + 8, right });
      setOpen(true);
    });
  };

  return (
    <>
      <View ref={ref} collapsable={false}>
        <Pressable onPress={() => void show()} hitSlop={8} className="h-9 w-9 items-center justify-center" accessibilityLabel="上下文用量">
          <Ring ratio={ratio} warn={warn} />
        </Pressable>
      </View>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => setOpen(false)}
      >
        <Pressable className="flex-1" onPress={() => setOpen(false)} />
        <View
          style={{ position: 'absolute', width: CARD_W, right: anchor.right, bottom: anchor.bottom }}
          className="rounded-2xl border border-border bg-background px-4 pb-3 pt-3 shadow-lg"
        >
          <View className="flex-row items-center gap-1.5 border-b border-border pb-2">
            <Icon as={Database} size={15} className="text-foreground" />
            <Text className="text-sm font-medium">Token 用量</Text>
            <Text numberOfLines={1} className="flex-1 text-right text-sm">{`${num(totalTokens)} tok`}</Text>
          </View>
          <Text numberOfLines={1} className="pt-1.5 text-[11px] text-muted-foreground">
            {model || '未选择模型'}
          </Text>
          <View className="pb-2 pt-0.5">
            <Row
              label="上下文"
              value={s ? `${formatTokens(s.contextTokens)} / ${formatWindow(contextWindow)}` : `— / ${formatWindow(contextWindow)}`}
            />
            {s ? (
              <>
                <Row label="已用" value={`${(ratio * 100).toFixed(1)}%`} warn={warn} />
                {hit !== null ? <Row label="缓存命中" value={`${hit}%`} /> : null}
                <Row label="未命中" value={`${num(s.promptTokens - s.cachedTokens)} tok`} />
                <Row label="缓存读取" value={`${num(s.cachedTokens)} tok`} />
                <Row label="输出" value={`${num(s.completionTokens ?? 0)} tok`} />
                {s.tokensPerSec != null ? (
                  <Row label="速度" value={`${s.tokensPerSec.toFixed(s.tokensPerSec < 10 ? 1 : 0)}${s.estimated ? '≈' : ''} tok/s`} />
                ) : null}
              </>
            ) : (
              <Text className="py-1 text-xs text-muted-foreground">发送消息后显示本次请求的用量</Text>
            )}
          </View>
          <Pressable
            onPress={() => {
              setOpen(false);
              onCompress();
            }}
            disabled={running}
            className={cn('h-9 items-center justify-center rounded-full bg-primary active:opacity-90', running && 'opacity-40')}
          >
            <Text className="text-sm font-medium text-primary-foreground">压缩上下文</Text>
          </Pressable>
          <Text className="mt-1.5 text-center text-[10px] text-muted-foreground">
            {`超过 ${Math.round(AUTO_COMPRESS_RATIO * 100)}% 时自动压缩较早的对话`}
          </Text>
        </View>
      </Modal>
    </>
  );
}
