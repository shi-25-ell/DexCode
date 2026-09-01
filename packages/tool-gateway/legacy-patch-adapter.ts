import type { PatchFileInput } from './structured-edit.ts';

function stripFence(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n');
  const fenced = normalized.match(/^```(?:diff|patch|text)?[^\n]*\n([\s\S]*)\n```$/i);
  return fenced ? fenced[1] : normalized;
}

/** Temporary backend-only adapter. Legacy input is intentionally absent from the model registry. */
export function adaptLegacyPatch(path: string, patch: string): PatchFileInput {
  const text = stripFence(patch);
  if (text.length === 0) throw new Error('Legacy patch content is empty');
  if (text.includes('\n---\n')) {
    const delimiter = text.indexOf('\n---\n');
    return {
      path,
      mode: 'targeted',
      edits: [{ old_text: text.slice(0, delimiter), new_text: text.slice(delimiter + 5) }],
    };
  }
  const spacedArrow = text.indexOf(' => ');
  const arrow = spacedArrow >= 0 ? spacedArrow : text.indexOf('=>');
  if (arrow >= 0) {
    const delimiterLength = spacedArrow >= 0 ? 4 : 2;
    return {
      path,
      mode: 'targeted',
      edits: [{ old_text: text.slice(0, arrow), new_text: text.slice(arrow + delimiterLength) }],
    };
  }
  throw new Error('Legacy patch format is unsupported; migrate to targeted or replace_all input');
}
