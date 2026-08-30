import { Check, Copy, X } from 'lucide-react';
import { useEffect, useState } from 'react';

type CopyState = 'idle' | 'copied' | 'failed';
type CopyKind = 'assistant' | 'user';

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

function copyLabel(kind: CopyKind, state: CopyState): string {
  const target = kind === 'assistant' ? '回答' : '我的消息';
  if (state === 'copied') return `已复制${target}`;
  if (state === 'failed') return `复制失败，重试复制${target}`;
  return `复制${target}`;
}

export function MessageCopyButton({ content, kind }: { content: string; kind: CopyKind }) {
  const [copyState, setCopyState] = useState<CopyState>('idle');

  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = window.setTimeout(() => setCopyState('idle'), 1800);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const copyMessage = async () => {
    try {
      await copyText(content);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  const label = copyLabel(kind, copyState);
  return (
    <button
      type="button"
      className={`copy-response ${copyState}`}
      onClick={() => void copyMessage()}
      aria-label={label}
      title={copyState === 'idle' ? label : undefined}
    >
      {copyState === 'copied' ? <Check size={15} /> : copyState === 'failed' ? <X size={15} /> : <Copy size={15} />}
      {copyState !== 'idle' ? <span aria-live="polite">{copyState === 'copied' ? '已复制' : '复制失败'}</span> : null}
    </button>
  );
}
