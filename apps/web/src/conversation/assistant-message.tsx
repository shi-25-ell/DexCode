import { Check, Copy, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type CopyState = 'idle' | 'copied' | 'failed';

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Clipboard is unavailable');
}

export function AssistantMessage({ content }: { content: string }) {
  const [copyState, setCopyState] = useState<CopyState>('idle');

  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = window.setTimeout(() => setCopyState('idle'), 1800);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const copyResponse = async () => {
    try {
      await copyText(content);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  const label = copyState === 'copied'
    ? '已复制回答'
    : copyState === 'failed'
      ? '复制失败，重试复制回答'
      : '复制回答';

  return (
    <article className="assistant-message">
      <div className="assistant-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
      <div className="assistant-actions">
        <button
          type="button"
          className={`copy-response ${copyState}`}
          onClick={() => void copyResponse()}
          aria-label={label}
          title={copyState === 'idle' ? '复制回答' : undefined}
        >
          {copyState === 'copied' ? <Check size={15} /> : copyState === 'failed' ? <X size={15} /> : <Copy size={15} />}
          {copyState !== 'idle' ? <span aria-live="polite">{copyState === 'copied' ? '已复制' : '复制失败'}</span> : null}
        </button>
      </div>
    </article>
  );
}
