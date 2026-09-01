import { createTwoFilesPatch } from 'diff';

export type TargetedPatchInput = {
  path: string;
  mode: 'targeted';
  edits: Array<{ old_text: string; new_text: string }>;
};

export type ReplaceAllPatchInput = {
  path: string;
  mode: 'replace_all';
  old_text: string;
  new_text: string;
  expected_occurrences: number;
};

export type PatchFileInput = TargetedPatchInput | ReplaceAllPatchInput;

export type StructuredEditResult = {
  content: string;
  replacements: number;
  beforeLines: number;
  afterLines: number;
  diff: string;
  eol: 'LF' | 'CRLF';
  bom: boolean;
};

function normalizedText(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function occurrences(content: string, search: string): number[] {
  const output: number[] = [];
  for (let cursor = 0; cursor <= content.length - search.length;) {
    const index = content.indexOf(search, cursor);
    if (index < 0) break;
    output.push(index);
    cursor = index + search.length;
  }
  return output;
}

function lineCount(value: string): number {
  return value.length === 0 ? 0 : normalizedText(value).split('\n').length;
}

export function applyStructuredEdit(original: string, input: PatchFileInput): StructuredEditResult {
  const bom = original.startsWith('\uFEFF');
  const withoutBom = bom ? original.slice(1) : original;
  const eol = /\r\n/.test(withoutBom) ? 'CRLF' as const : 'LF' as const;
  const source = normalizedText(withoutBom);
  let next = source;
  let replacements = 0;

  if (input.mode === 'targeted') {
    if (!Array.isArray(input.edits) || input.edits.length === 0) throw new Error('targeted edits must not be empty');
    const ranges: Array<{ start: number; end: number; replacement: string }> = [];
    for (let index = 0; index < input.edits.length; index += 1) {
      const edit = input.edits[index];
      const oldText = normalizedText(edit.old_text);
      const newText = normalizedText(edit.new_text);
      if (!oldText) throw new Error(`edits[${index}].old_text must not be empty`);
      const found = occurrences(source, oldText);
      if (found.length !== 1) throw new Error(`edits[${index}].old_text expected exactly 1 occurrence but found ${found.length}`);
      if (oldText === newText) throw new Error(`edits[${index}] does not change the file`);
      ranges.push({ start: found[0], end: found[0] + oldText.length, replacement: newText });
    }
    ranges.sort((left, right) => left.start - right.start);
    for (let index = 1; index < ranges.length; index += 1) {
      if (ranges[index].start < ranges[index - 1].end) throw new Error('targeted edits overlap');
    }
    for (const range of [...ranges].reverse()) {
      next = `${next.slice(0, range.start)}${range.replacement}${next.slice(range.end)}`;
    }
    replacements = ranges.length;
  } else {
    const oldText = normalizedText(input.old_text);
    const newText = normalizedText(input.new_text);
    if (!oldText) throw new Error('old_text must not be empty');
    if (oldText === newText) throw new Error('old_text and new_text must differ');
    if (!Number.isInteger(input.expected_occurrences) || input.expected_occurrences < 1) {
      throw new Error('expected_occurrences must be a positive integer');
    }
    const found = occurrences(source, oldText);
    if (found.length !== input.expected_occurrences) {
      throw new Error(`expected ${input.expected_occurrences} occurrences but found ${found.length}`);
    }
    next = source.split(oldText).join(newText);
    replacements = found.length;
  }

  const stored = (eol === 'CRLF' ? next.replace(/\n/g, '\r\n') : next);
  const content = `${bom ? '\uFEFF' : ''}${stored}`;
  return {
    content,
    replacements,
    beforeLines: lineCount(withoutBom),
    afterLines: lineCount(stored),
    diff: createTwoFilesPatch(input.path, input.path, withoutBom, stored, 'before', 'after', { context: 3 }),
    eol,
    bom,
  };
}
