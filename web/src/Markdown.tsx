import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const SAFE_PROTOCOLS = /^(https?:|mailto:|#|\/)/i;

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={url => (SAFE_PROTOCOLS.test(url) ? url : '')}
        components={{
          a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
          img: ({ alt }) => <span className="muted">［画像: {alt || '表示しません'}］</span>,
          table: ({ children }) => <div className="table-wrap"><table>{children}</table></div>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
