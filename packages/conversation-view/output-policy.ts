const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const SECRET_KEY = /^(?:api[_-]?key|authorization|access[_-]?token|token|secret|password)$/i;
const INLINE_SECRET = /(["']?(?:api[_-]?key|authorization|access[_-]?token|token|secret|password)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,;}]+)/gi;

function serialize(value: unknown): string {
  if (typeof value === 'string') return value;
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (key, item: unknown) => {
    if (SECRET_KEY.test(key)) return '[已隐藏]';
    if (item && typeof item === 'object') {
      if (seen.has(item)) return '[循环引用]';
      seen.add(item);
    }
    return item;
  }, 2);
}

export function safeRawOutput(value: unknown, maxChars = 64 * 1024, maxLines = 200): { text?: string; truncated: boolean } {
  let text: string;
  try {
    text = serialize(value);
  } catch {
    text = '[输出无法序列化]';
  }
  text = text.replace(ANSI, '').replace(CONTROL_CHARACTERS, '').replace(INLINE_SECRET, '$1[已隐藏]');
  const lines = text.split(/\r?\n/);
  let truncated = false;
  if (lines.length > maxLines) {
    const head = lines.slice(0, Math.floor(maxLines * 0.75));
    const tail = lines.slice(-Math.ceil(maxLines * 0.25));
    text = [...head, '… 输出已截断 …', ...tail].join('\n');
    truncated = true;
  }
  if (text.length > maxChars) {
    const tailSize = Math.min(4096, Math.floor(maxChars * 0.2));
    text = `${text.slice(0, maxChars - tailSize)}\n… 输出已截断 …\n${text.slice(-tailSize)}`;
    truncated = true;
  }
  return { ...(text.trim() ? { text } : {}), truncated };
}
