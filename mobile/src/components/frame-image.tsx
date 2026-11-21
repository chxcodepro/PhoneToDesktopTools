import { useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';

interface Slots {
  uris: [string | null, string | null];
  front: 0 | 1; // 正在显示的槽位
  busy: boolean; // 另一个槽位正在解码
}

/**
 * 虚拟桌面画面（双缓冲）。
 *
 * 画面变化频繁时每帧都是新图片，直接替换 Image 的 uri 会让上一张还没解码完就被取消，结果一张都显示不出来。
 * 这里用两个 Image 轮流：新帧在后面的槽位解码，完成后才切到前面；解码期间到达的帧只保留最新一张。
 */
export function FrameImage({ uri }: { uri: string }) {
  const [s, setS] = useState<Slots>({ uris: [null, null], front: 0, busy: false });

  // 渲染时调整状态（React 允许的写法）：空闲且有新帧时，放进后面的槽位开始解码
  if (!s.busy && uri !== s.uris[s.front]) {
    const back = s.front === 0 ? 1 : 0;
    const uris: [string | null, string | null] = [...s.uris];
    uris[back] = uri;
    setS({ uris, front: s.front, busy: true });
  }

  const back = s.front === 0 ? 1 : 0;
  const onBackLoaded = () => setS((p) => ({ ...p, front: p.front === 0 ? 1 : 0, busy: false }));

  return (
    // collapsable={false}：防止这一层被视图扁平化合并掉，否则里面带 zIndex 的图片会盖住鼠标等叠加层
    <View style={StyleSheet.absoluteFill} collapsable={false}>
      {([0, 1] as const).map((i) =>
        s.uris[i] ? (
          <Image
            key={i}
            source={{ uri: s.uris[i] }}
            fadeDuration={0}
            onLoadEnd={i === back && s.busy ? onBackLoaded : undefined}
            style={[StyleSheet.absoluteFill, { zIndex: i === s.front ? 1 : 0 }]}
          />
        ) : null,
      )}
    </View>
  );
}
