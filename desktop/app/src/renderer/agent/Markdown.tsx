// 助手回答的 Markdown 渲染。不渲染原始 HTML；链接在系统浏览器里打开；不加载网络图片（只显示成链接）。
import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
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
