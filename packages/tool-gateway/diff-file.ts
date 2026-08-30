import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type DiffHunk = {
  type: 'equal' | 'add' | 'remove';
  line: string;
  oldLineNo?: number;
  newLineNo?: number;
};

export type DiffFileResult = {
  path: string;
  snapshotId: string;
  snapshotName: string;
  hunks: DiffHunk[];
  stats: { added: number; removed: number; unchanged: number };
  error?: string;
};

function computeLineDiff(oldLines: string[], newLines: string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  let oldNo = 1;
  let newNo = 1;

  for (let i = 0; i < maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;

    if (oldLine === newLine && oldLine !== undefined) {
      hunks.push({ type: 'equal', line: oldLine, oldLineNo: oldNo++, newLineNo: newNo++ });
    } else {
      if (oldLine !== undefined) {
        hunks.push({ type: 'remove', line: oldLine, oldLineNo: oldNo++ });
      }
      if (newLine !== undefined) {
        hunks.push({ type: 'add', line: newLine, newLineNo: newNo++ });
      }
    }
  }

  return hunks;
}

type SnapshotRef = {
  id: string;
  name: string;
  snapshotPath: string;
};

export async function diffFileAgainstSnapshot(options: {
  path: string;
  workspaceRoot: string;
  projectDir: string;
  snapshotId?: string;
  listVersions: () => Promise<SnapshotRef[]>;
}): Promise<DiffFileResult> {
  const relPath = options.path.replace(/\\/g, '/').replace(/^\/+/, '');
  const versions = await options.listVersions();
  if (versions.length === 0) {
    return {
      path: relPath,
      snapshotId: '',
      snapshotName: '',
      hunks: [],
      stats: { added: 0, removed: 0, unchanged: 0 },
      error: '尚无版本快照，请先 create_snapshot',
    };
  }

  const snapshot =
    (options.snapshotId
      ? versions.find((v) => v.id === options.snapshotId)
      : versions[0]) ?? versions[0];

  const snapshotDir = resolve(options.projectDir, snapshot.snapshotPath);
  const currentPath = resolve(join(options.workspaceRoot, relPath));
  const oldPath = resolve(join(snapshotDir, relPath));

  if (!currentPath.startsWith(resolve(options.workspaceRoot))) {
    return {
      path: relPath,
      snapshotId: snapshot.id,
      snapshotName: snapshot.name,
      hunks: [],
      stats: { added: 0, removed: 0, unchanged: 0 },
      error: '路径越界',
    };
  }

  let oldContent = '';
  let newContent = '';

  try {
    newContent = await readFile(currentPath, 'utf8');
  } catch {
    return {
      path: relPath,
      snapshotId: snapshot.id,
      snapshotName: snapshot.name,
      hunks: [],
      stats: { added: 0, removed: 0, unchanged: 0 },
      error: '当前工作区中找不到该文件',
    };
  }

  try {
    oldContent = await readFile(oldPath, 'utf8');
  } catch {
    const newLines = newContent.split(/\r?\n/);
    const hunks = newLines.map((line, idx) => ({
      type: 'add' as const,
      line,
      newLineNo: idx + 1,
    }));
    return {
      path: relPath,
      snapshotId: snapshot.id,
      snapshotName: snapshot.name,
      hunks,
      stats: { added: newLines.length, removed: 0, unchanged: 0 },
    };
  }

  const oldLines = oldContent.split(/\r?\n/);
  const newLines = newContent.split(/\r?\n/);
  const hunks = computeLineDiff(oldLines, newLines);

  const stats = hunks.reduce(
    (acc, h) => {
      if (h.type === 'add') acc.added++;
      else if (h.type === 'remove') acc.removed++;
      else acc.unchanged++;
      return acc;
    },
    { added: 0, removed: 0, unchanged: 0 },
  );

  return {
    path: relPath,
    snapshotId: snapshot.id,
    snapshotName: snapshot.name,
    hunks: hunks.slice(0, 500),
    stats,
    ...(hunks.length > 500 ? { error: '差异过大，仅返回前 500 行变更' } : {}),
  };
}
