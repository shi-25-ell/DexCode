import { RefreshCw, X } from 'lucide-react';
import type { ReactNode } from 'react';

export function PanelHeader({ title, description, onRefresh, action }: { title: string; description: string; onRefresh?: () => void; action?: ReactNode }) {
  return <div className="settings-panel-header"><div><h2>{title}</h2><p>{description}</p></div><div className="settings-header-actions">{action}{onRefresh ? <button className="secondary-button" onClick={onRefresh}><RefreshCw size={15} />刷新</button> : null}</div></div>;
}

export function Toggle({ enabled, onChange, label, disabled }: { enabled: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return <button type="button" className={enabled ? 'toggle on' : 'toggle'} onClick={onChange} disabled={disabled} aria-label={`${label}：${enabled ? '已启用' : '已禁用'}`}><span /></button>;
}

export function SettingsFeedback({ error, empty, loading }: { error?: unknown; empty?: string; loading?: boolean }) {
  if (loading) return <div className="settings-feedback">正在加载…</div>;
  if (error) return <div className="settings-feedback error">{error instanceof Error ? error.message : '加载失败'}</div>;
  if (empty) return <div className="settings-feedback">{empty}</div>;
  return null;
}

export function SettingsDialog({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return <div className="settings-dialog-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={wide ? 'settings-dialog wide' : 'settings-dialog'} role="dialog" aria-modal="true" aria-label={title}><header><h3>{title}</h3><button type="button" aria-label="关闭" onClick={onClose}><X size={17} /></button></header>{children}</section></div>;
}

export function JsonResult({ value }: { value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return <details className="raw-settings-result"><summary>查看原始结果</summary><pre>{text}</pre></details>;
}
