// 助手回答的 Markdown 渲染。不渲染原始 HTML；链接在系统浏览器里打开；不加载网络图片（只显示成链接）。
import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { GENUI_LANG, parseGenui } from '@agent/genui';
import { Genui } from './Genui';

/** 代码块的文字（hast 节点） */
function nodeText(n: unknown): string {
  const x = n as { value?: string; children?: unknown[] };
  if (typeof x?.value === 'string') return x.value;
  return (x?.children ?? []).map(nodeText).join('');
}

const components: Components = {
  // ```p2d-ui 代码块渲染成卡片；JSON 还没写完（正在生成）或不合法时显示提示，可以展开看原文
  pre: ({ node, children }) => {
    const code = node?.children?.[0] as { tagName?: string; properties?: { className?: unknown } } | undefined;
    const cls = code?.properties?.className;
    if (code?.tagName === 'code' && Array.isArray(cls) && cls.includes(`language-${GENUI_LANG}`)) {
      const spec = parseGenui(nodeText(code));
      if (spec) return <Genui spec={spec} />;
      return (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">卡片内容生成中…</summary>
          <pre>{children}</pre>
        </details>
      );
    }
    return <pre>{children}</pre>;
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" title={href}>
      {children}
    </a>
  ),
  img: ({ src, alt }) => (
    <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noreferrer">
      [图片{alt ? `：${alt}` : ''}]
    </a>
  ),
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};

/** 只允许 http / https / mailto 链接 */
function safeUrl(url: string): string {
  return /^(https?:|mailto:)/i.test(url) ? url : '';
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md select-text">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={safeUrl}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
