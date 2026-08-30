import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageCopyButton } from './message-copy-button';

const markdownComponents: Components = {
  table({ node: _node, ...props }) {
    return (
      <div className="markdown-table-scroll" role="region" aria-label="表格，可横向滚动" tabIndex={0}>
        <table {...props} />
      </div>
    );
  },
};

export function AssistantMessage({ content, copyContent = content, showCopy = true }: { content: string; copyContent?: string; showCopy?: boolean }) {
  return (
    <article className="assistant-message">
      <div className="assistant-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</ReactMarkdown>
      </div>
      {showCopy ? <div className="assistant-actions"><MessageCopyButton content={copyContent} kind="assistant" /></div> : null}
    </article>
  );
}
