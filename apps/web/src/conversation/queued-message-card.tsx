import { ArrowDown, ArrowUp, CornerUpLeft, GripVertical, Trash2 } from 'lucide-react';
import type { QueueItem } from '../types';

export function QueuedMessageCard({
  item,
  busy,
  canPromote,
  canMoveUp,
  canMoveDown,
  onPromote,
  onDelete,
  onMove,
  onDragStart,
  onDrop,
}: {
  item: QueueItem;
  busy: boolean;
  canPromote: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onPromote: () => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  return (
    <article
      className={`queued-message-card ${item.delivery}`}
      draggable={!busy}
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); onDrop(); }}
    >
      <GripVertical className="queue-drag" size={16} aria-hidden="true" />
      <div className="queue-message-body">
        <span className="queue-kind">{item.delivery === 'steer' ? '将在安全边界调整方向' : '等待下一轮'}</span>
        <p>{item.content}</p>
      </div>
      <div className="queue-card-actions">
        <button type="button" disabled={busy || !canMoveUp} onClick={() => onMove(-1)} aria-label="上移"><ArrowUp size={14} /></button>
        <button type="button" disabled={busy || !canMoveDown} onClick={() => onMove(1)} aria-label="下移"><ArrowDown size={14} /></button>
        {item.delivery === 'next_run' ? <button type="button" disabled={busy || !canPromote} onClick={onPromote}><CornerUpLeft size={14} />调整方向</button> : null}
        <button type="button" disabled={busy} onClick={onDelete} aria-label="删除队列消息"><Trash2 size={14} /></button>
      </div>
    </article>
  );
}
