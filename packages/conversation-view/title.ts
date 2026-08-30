const PREFIX = /^(?:#{1,6}\s+|[-*+]\s+|```[\p{L}\p{N}_-]*\s*)/u;

export function conversationTitle(input: string, limit = 36): string {
  const normalized = input.trim().replace(PREFIX, '').replace(/\s+/g, ' ');
  if (!normalized) return '恢复的会话';
  const segments = typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(normalized)].map((part) => part.segment)
    : Array.from(normalized);
  return segments.length > limit ? `${segments.slice(0, limit).join('')}…` : normalized;
}
