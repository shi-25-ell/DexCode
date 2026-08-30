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

function readableContent(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => readableContent(item, depth + 1)).filter(Boolean).join('\n\n');
  if (typeof value !== 'object' || depth > 4) return String(value);

  const object = value as Record<string, unknown>;
  for (const key of ['content', 'text', 'output', 'message'] as const) {
    if (key in object) {
      const rendered = readableContent(object[key], depth + 1);
      if (rendered) return rendered;
    }
  }
  const streams = [
    typeof object.stdout === 'string' && object.stdout ? object.stdout : '',
    typeof object.stderr === 'string' && object.stderr ? `标准错误\n${object.stderr}` : '',
  ].filter(Boolean);
  if (streams.length) return streams.join('\n\n');

  return Object.entries(object)
    .filter(([key]) => !['ok', 'status'].includes(key))
    .map(([key, item]) => {
      const rendered = readableContent(item, depth + 1);
      if (!rendered) return '';
      return typeof item === 'object' && item !== null ? `${key}\n${rendered}` : `${key}: ${rendered}`;
    })
    .filter(Boolean)
    .join('\n\n');
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

export function safeDisplayOutput(value: unknown, maxChars = 64 * 1024, maxLines = 200): { text?: string; truncated: boolean } {
  const rendered = readableContent(value);
  return rendered ? safeRawOutput(rendered, maxChars, maxLines) : { truncated: false };
}
