import { useQuery } from '@tanstack/react-query';
import { FolderClock, FolderSearch2, X } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { listRecentWorkspaces, suggestWorkspacePaths } from '../api';

export const WORKSPACE_HISTORY_KEY = 'dexcode.workspaceHistory.v1';
export const WORKSPACE_HIDDEN_HISTORY_KEY = 'dexcode.hiddenWorkspaceHistory.v1';
const HISTORY_LIMIT = 10;

export type WorkspaceSuggestion = { path: string; source: 'recent' | 'filesystem' };

function comparablePath(path: string): string {
  return path.trim().replace(/[\\/]+$/, '').toLocaleLowerCase();
}

export function mergeWorkspaceSuggestions(prefix: string, recent: string[], filesystem: string[]): WorkspaceSuggestion[] {
  const normalizedPrefix = comparablePath(prefix);
  const items: WorkspaceSuggestion[] = [];
  const seen = new Set<string>();
  const append = (path: string, source: WorkspaceSuggestion['source']) => {
    const key = comparablePath(path);
    if (!key || seen.has(key) || (normalizedPrefix && !key.startsWith(normalizedPrefix))) return;
    seen.add(key);
    items.push({ path, source });
  };
  recent.forEach((path) => append(path, 'recent'));
  filesystem.forEach((path) => append(path, 'filesystem'));
  return items.slice(0, HISTORY_LIMIT);
}

function readLocalHistory(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKSPACE_HISTORY_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function readHiddenHistory(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKSPACE_HIDDEN_HISTORY_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function writeHiddenHistory(paths: string[]): string[] {
  const next = paths.slice(0, HISTORY_LIMIT);
  localStorage.setItem(WORKSPACE_HIDDEN_HISTORY_KEY, JSON.stringify(next));
  return next;
}

function writeLocalHistory(path: string): string[] {
  const next = [path, ...readLocalHistory().filter((item) => comparablePath(item) !== comparablePath(path))].slice(0, HISTORY_LIMIT);
  localStorage.setItem(WORKSPACE_HISTORY_KEY, JSON.stringify(next));
  return next;
}

export function WorkspacePicker({
  value,
  loading,
  error,
  onChange,
  onResolve,
}: {
  value: string;
  loading: boolean;
  error?: string;
  onChange: (value: string) => void;
  onResolve: (path: string) => Promise<boolean>;
}) {
  const [focused, setFocused] = useState(false);
  const [debounced, setDebounced] = useState(value);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [localHistory, setLocalHistory] = useState<string[]>(() => readLocalHistory());
  const [hiddenHistory, setHiddenHistory] = useState<string[]>(() => readHiddenHistory());
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value.trim()), 160);
    return () => clearTimeout(timer);
  }, [value]);

  const recent = useQuery({
    queryKey: ['recent-workspaces'],
    queryFn: listRecentWorkspaces,
    staleTime: 30_000,
    retry: false,
  });
  const filesystem = useQuery({
    queryKey: ['workspace-suggestions', debounced],
    queryFn: () => suggestWorkspacePaths(debounced),
    enabled: focused && Boolean(debounced),
    retry: false,
  });
  const suggestions = useMemo(() => {
    const hidden = new Set(hiddenHistory.map(comparablePath));
    return mergeWorkspaceSuggestions(
      value,
      [...localHistory, ...(recent.data ?? []).map((workspace) => workspace.path)].filter((path) => !hidden.has(comparablePath(path))),
      filesystem.data ?? [],
    );
  }, [filesystem.data, hiddenHistory, localHistory, recent.data, value]);
  const open = focused && suggestions.length > 0;

  useEffect(() => setActiveIndex((index) => Math.min(index, suggestions.length - 1)), [suggestions.length]);

  const choose = (path: string) => {
    onChange(path);
    setActiveIndex(-1);
  };
  const forgetRecent = (path: string) => {
    const key = comparablePath(path);
    const nextLocal = readLocalHistory().filter((item) => comparablePath(item) !== key);
    localStorage.setItem(WORKSPACE_HISTORY_KEY, JSON.stringify(nextLocal));
    setLocalHistory(nextLocal);
    setHiddenHistory((current) => writeHiddenHistory([path, ...current.filter((item) => comparablePath(item) !== key)]));
    setActiveIndex(-1);
  };
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const path = value.trim();
    if (await onResolve(path)) {
      if (path) {
        setLocalHistory(writeLocalHistory(path));
        setHiddenHistory((current) => writeHiddenHistory(current.filter((item) => comparablePath(item) !== comparablePath(path))));
      }
      setFocused(false);
    }
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setFocused(false);
      return;
    }
    if (event.key === 'ArrowDown' && suggestions.length) {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % suggestions.length);
      return;
    }
    if (event.key === 'ArrowUp' && suggestions.length) {
      event.preventDefault();
      setActiveIndex((index) => index <= 0 ? suggestions.length - 1 : index - 1);
      return;
    }
    if ((event.key === 'Tab' || event.key === 'Enter') && activeIndex >= 0 && suggestions[activeIndex]) {
      event.preventDefault();
      choose(suggestions[activeIndex].path);
      return;
    }
    if (event.key === 'Tab' && suggestions[0]) {
      event.preventDefault();
      choose(suggestions[0].path);
    }
  };

  return (
    <div className="workspace-picker">
      <form className="workspace-form" onSubmit={(event) => void submit(event)}>
        <div className="workspace-combobox">
          <input
            aria-label="项目绝对路径"
            aria-autocomplete="list"
            aria-controls="workspace-suggestions"
            aria-expanded={open}
            role="combobox"
            value={value}
            onChange={(event) => { onChange(event.target.value); setFocused(true); setActiveIndex(-1); }}
            onFocus={() => { if (blurTimer.current) clearTimeout(blurTimer.current); setFocused(true); }}
            onBlur={() => { blurTimer.current = setTimeout(() => setFocused(false), 100); }}
            onKeyDown={handleKeyDown}
            placeholder="输入项目绝对路径"
            spellCheck={false}
          />
          {open ? (
            <ul id="workspace-suggestions" className="workspace-suggestions" role="listbox">
              {suggestions.map((suggestion, index) => (
                <li
                  key={`${suggestion.source}:${suggestion.path}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={index === activeIndex ? 'active' : ''}
                  onMouseDown={(event) => { event.preventDefault(); choose(suggestion.path); }}
                >
                  {suggestion.source === 'recent' ? <FolderClock size={15} /> : <FolderSearch2 size={15} />}
                  <span title={suggestion.path}>{suggestion.path}</span>
                  <small>{suggestion.source === 'recent' ? '最近项目' : '路径建议'}</small>
                  {suggestion.source === 'recent' ? (
                    <button
                      type="button"
                      className="workspace-suggestion-delete"
                      aria-label={`从最近项目移除 ${suggestion.path}`}
                      title="从最近项目移除"
                      onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
                      onClick={(event) => { event.preventDefault(); event.stopPropagation(); forgetRecent(suggestion.path); }}
                    >
                      <X size={13} />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <button type="submit" disabled={loading}>{loading ? '加载中' : '加载'}</button>
      </form>
      {error ? <p className="inline-error">{error}</p> : null}
    </div>
  );
}
