import { MessageCopyButton } from './message-copy-button';

export function UserMessage({ content }: { content: string }) {
  return (
    <div className="user-message-group">
      <div className="user-message">{content}</div>
      <div className="user-message-actions">
        <MessageCopyButton content={content} kind="user" />
      </div>
    </div>
  );
}
