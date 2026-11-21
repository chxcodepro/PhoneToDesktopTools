// 助手回答的 Markdown 渲染：用 marked 解析成语法树，再渲染成 React Native 组件，样式与应用主题一致。
// 支持：标题、段落、粗体/斜体/删除线、行内代码、代码块、有序/无序/任务列表（可嵌套）、引用、表格、分隔线、链接。
//
// Android 注意：宽度由内容决定的文字（横向滚动区里、表格单元格里），测量出的宽度可能比绘制所需少不到 1 像素，
// 最后一段会被挤到第二行然后被裁掉（如「C:\Users\Administrator」只显示「C:」）。所以表格用估算的固定列宽，
// 代码块每行禁止换行。横向 ScrollView 默认 flexGrow: 1，会把剩余空间撑满，这里都设为 0。

import { marked, type Token, type Tokens } from 'marked';
import { createContext, memo, useContext, useMemo, type ReactNode } from 'react';
import { Linking, ScrollView, View } from 'react-native';

import { GENUI_LANG } from '@/agent/genui';
import { GenuiBlock } from '@/components/genui';
import { Text, TextClassContext } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/** 行内元素 */
function renderInline(tokens: Token[] | undefined, keyPrefix: string): ReactNode[] {
  if (!tokens) return [];
  return tokens.map((t, i) => {
    const key = `${keyPrefix}.${i}`;
    switch (t.type) {
      case 'strong':
        return (
          <Text key={key} className="text-sm font-semibold leading-6">
            {renderInline((t as Tokens.Strong).tokens, key)}
          </Text>
        );
      case 'em':
        return (
          <Text key={key} className="text-sm italic leading-6">
            {renderInline((t as Tokens.Em).tokens, key)}
          </Text>
        );
      case 'del':
        return (
          <Text key={key} className="text-sm leading-6 line-through">
            {renderInline((t as Tokens.Del).tokens, key)}
          </Text>
        );
      case 'codespan':
        return (
          <Text key={key} className="rounded bg-muted font-mono text-[13px] text-foreground">
            {` ${decodeEntities((t as Tokens.Codespan).text)} `}
          </Text>
        );
      case 'link': {
        const l = t as Tokens.Link;
        return (
          <Text key={key} className="text-sm leading-6 text-primary underline" onPress={() => void Linking.openURL(l.href)}>
            {renderInline(l.tokens, key)}
          </Text>
        );
      }
      case 'image': {
        const img = t as Tokens.Image;
        return (
          <Text key={key} className="text-sm leading-6 text-primary underline" onPress={() => void Linking.openURL(img.href)}>
            {`[图片：${img.text || img.href}]`}
          </Text>
        );
      }
      case 'br':
        return <Text key={key}>{'\n'}</Text>;
      case 'text': {
        const tt = t as Tokens.Text;
        return tt.tokens ? (
          <Text key={key} className="text-sm leading-6">
            {renderInline(tt.tokens, key)}
          </Text>
        ) : (
          decodeEntities(tt.text)
        );
      }
      case 'escape':
        return (t as Tokens.Escape).text;
      case 'html':
        return (t as Tokens.HTML).text;
      default:
        return 'raw' in t ? String(t.raw) : '';
    }
  });
}

/** marked 会把 & < > " ' 转成实体，显示时还原 */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function Paragraph({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Text selectable className={cn('text-sm leading-6', className)}>
      {children}
    </Text>
  );
}

const HEADING_CLASS: Record<number, string> = {
  1: 'text-lg font-bold leading-7',
  2: 'text-base font-bold leading-7',
  3: 'text-[15px] font-semibold leading-6',
  4: 'text-sm font-semibold leading-6',
  5: 'text-sm font-semibold leading-6',
  6: 'text-sm font-semibold leading-6 text-muted-foreground',
};

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const lines = code.replace(/\n$/, '').split('\n');
  return (
    <View className="overflow-hidden rounded-md border border-border bg-muted">
      {lang ? (
        <View className="border-b border-border px-3 py-1">
          <Text className="font-mono text-[11px] text-muted-foreground">{lang}</Text>
        </View>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
        <View className="px-3 py-2">
          {lines.map((line, i) => (
            // 每行单独一个 Text 且只占一行；末尾补空格吸收测量误差
            <Text key={i} numberOfLines={1} ellipsizeMode="clip" className="font-mono text-[12px] leading-5 text-foreground">
              {`${line} `}
            </Text>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

/** 行内元素的纯文字（用于估算表格列宽） */
function plainText(tokens: Token[] | undefined): string {
  if (!tokens) return '';
  return tokens
    .map((t) => {
      const inner = (t as { tokens?: Token[] }).tokens;
      if (inner?.length) return plainText(inner);
      return 'text' in t ? decodeEntities(String(t.text)) : '';
    })
    .join('');
}

/** 估算文字宽度（dp）：中日韩文字按 1 个字号宽，其余按 0.62 个字号宽 */
function estimateWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) em += /[\u2E80-\uFFEF]/.test(ch) ? 1 : 0.62;
  return em * fontSize;
}

const CELL_FONT = 12;
const CELL_PAD = 16; // px-2 左右内边距
const COL_MIN = 56;
const COL_MAX = 220;

/** 深色背景（如虚拟桌面的磨砂消息面板）上显示时为 true */
const InverseContext = createContext(false);

function Table({ token, k }: { token: Tokens.Table; k: string }) {
  const inverse = useContext(InverseContext);
  // 每列用同一个宽度：按最长的单元格估算并留 20% 余量，超过上限时在单元格内换行
  const widths = token.header.map((h, ci) => {
    const longest = Math.max(
      estimateWidth(plainText(h.tokens), CELL_FONT),
      ...token.rows.map((r) => estimateWidth(plainText(r[ci]?.tokens), CELL_FONT)),
    );
    return Math.round(Math.min(COL_MAX, Math.max(COL_MIN, longest * 1.2 + CELL_PAD + 4)));
  });
  const cell = (c: Tokens.TableCell | undefined, ci: number, header: boolean, rk: string) => (
    <View
      key={`${rk}.${ci}`}
      style={{ width: widths[ci] }}
      className={cn(
        'border-r px-2 py-1.5',
        inverse ? 'border-white/20' : 'border-border',
        header && (inverse ? 'bg-white/10' : 'bg-muted'),
        ci === widths.length - 1 && 'border-r-0',
      )}
    >
      <Text className={cn('text-xs leading-5', header && 'font-semibold')}>{renderInline(c?.tokens, `${rk}.${ci}`)}</Text>
    </View>
  );
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
      <View className="overflow-hidden rounded-md border border-border">
        <View className="flex-row">{token.header.map((c, ci) => cell(c, ci, true, `${k}.h`))}</View>
        {token.rows.map((row, ri) => (
          <View key={`${k}.r${ri}`} className="flex-row border-t border-border">
            {token.header.map((_, ci) => cell(row[ci], ci, false, `${k}.r${ri}`))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function List({ token, k, depth }: { token: Tokens.List; k: string; depth: number }) {
  const start = typeof token.start === 'number' ? token.start : 1;
  return (
    <View className="gap-1">
      {token.items.map((item, i) => {
        const marker = item.task ? (item.checked ? '☑' : '☐') : token.ordered ? `${start + i}.` : depth % 2 === 0 ? '•' : '◦';
        return (
          <View key={`${k}.${i}`} className="flex-row gap-1.5">
            <Text className={cn('text-sm leading-6 text-muted-foreground', token.ordered ? 'min-w-5' : 'w-3')}>{marker}</Text>
            <View className="flex-1 gap-1">{renderBlocks(item.tokens, `${k}.${i}`, depth + 1, true)}</View>
          </View>
        );
      })}
    </View>
  );
}

/** 块级元素 */
function renderBlocks(tokens: Token[], keyPrefix: string, depth = 0, inList = false): ReactNode[] {
  const out: ReactNode[] = [];
  tokens.forEach((t, i) => {
    const k = `${keyPrefix}.${i}`;
    switch (t.type) {
      case 'space':
        return;
      case 'heading': {
        const h = t as Tokens.Heading;
        out.push(
          <Paragraph key={k} className={cn(HEADING_CLASS[h.depth] ?? HEADING_CLASS[4], i > 0 && 'mt-1')}>
            {renderInline(h.tokens, k)}
          </Paragraph>,
        );
        return;
      }
      case 'paragraph':
        out.push(<Paragraph key={k}>{renderInline((t as Tokens.Paragraph).tokens, k)}</Paragraph>);
        return;
      case 'text': {
        // 列表项里的紧凑文字
        const tt = t as Tokens.Text;
        out.push(<Paragraph key={k}>{tt.tokens ? renderInline(tt.tokens, k) : decodeEntities(tt.text)}</Paragraph>);
        return;
      }
      case 'code': {
        const c = t as Tokens.Code;
        const block = <CodeBlock key={k} code={c.text} lang={c.lang || undefined} />;
        if (c.lang === GENUI_LANG) {
          // 生成式界面：流式输出中代码块还没闭合时显示占位，解析失败时按普通代码块显示
          const closed = /(```|~~~)\s*$/.test(c.raw);
          out.push(<GenuiBlock key={k} code={c.text} closed={closed} fallback={block} />);
        } else out.push(block);
        return;
      }
      case 'list':
        out.push(<List key={k} token={t as Tokens.List} k={k} depth={inList ? depth : 0} />);
        return;
      case 'blockquote':
        out.push(
          <View key={k} className="gap-1 border-l-2 border-border pl-3">
            {renderBlocks((t as Tokens.Blockquote).tokens, k, depth)}
          </View>,
        );
        return;
      case 'table':
        out.push(<Table key={k} token={t as Tokens.Table} k={k} />);
        return;
      case 'hr':
        out.push(<View key={k} className="my-1 h-px bg-border" />);
        return;
      case 'html':
        out.push(<Paragraph key={k}>{(t as Tokens.HTML).text}</Paragraph>);
        return;
      default:
        if ('raw' in t && String(t.raw).trim()) out.push(<Paragraph key={k}>{String(t.raw)}</Paragraph>);
    }
  });
  return out;
}

/** 解析 Markdown；出错时（理论上不会）退回纯文字 */
export function parseMarkdown(text: string): Token[] {
  try {
    return marked.lexer(text, { gfm: true });
  } catch {
    return [{ type: 'paragraph', raw: text, text, tokens: [{ type: 'text', raw: text, text }] } as Tokens.Paragraph];
  }
}

export const Markdown = memo(function Markdown({ text, cursor, inverse }: { text: string; cursor?: boolean; inverse?: boolean }) {
  const tokens = useMemo(() => parseMarkdown(text), [text]);
  const body = (
    <View className="gap-2">
      {renderBlocks(tokens, 'md')}
      {cursor ? <Text className="text-sm leading-6 text-muted-foreground">▍</Text> : null}
    </View>
  );
  if (!inverse) return body;
  // 深色背景：正文改为浅色字（行内代码、代码块保留浅底深字，本身就清楚）
  return (
    <InverseContext.Provider value>
      <TextClassContext.Provider value="text-zinc-50">{body}</TextClassContext.Provider>
    </InverseContext.Provider>
  );
});
