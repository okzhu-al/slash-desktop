/**
 * TeamReadOnlyGuard — G-2 团队文件只读保护包装器
 *
 * 从 App.tsx 抽取，封装团队空间笔记的全面防护逻辑：
 * - 禁止复制/剪切/粘贴/右键/拖拽
 * - 拦截 Cmd+C / Cmd+A 并显示只读提示
 * - 自动聚焦以接收键盘事件
 */
import { useTranslation } from 'react-i18next';
import { Editor } from '@/features/editor';

interface TeamReadOnlyGuardProps {
  content: string;
  metadata: any;
  noteId: string;
}

export function TeamReadOnlyGuard({ content, metadata, noteId }: TeamReadOnlyGuardProps) {
  const { t } = useTranslation();

  return (
    <div
      className="flex-1 min-h-0 overflow-y-auto team-readonly-guard"
      tabIndex={0}
      ref={(el) => { if (el) el.focus(); }}
      style={{ userSelect: 'none', WebkitUserSelect: 'none', outline: 'none' }}
      onCopy={(e) => e.preventDefault()}
      onCut={(e) => e.preventDefault()}
      onPaste={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
      onDragStart={(e) => e.preventDefault()}
      onMouseDown={(e) => {
        setTimeout(() => (e.currentTarget as HTMLElement)?.focus(), 0);
      }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && ['c', 'C', 'a', 'A'].includes(e.key)) {
          e.preventDefault();
          e.stopPropagation();
          if (!(window as any).__teamReadOnlyAlertShown) {
            (window as any).__teamReadOnlyAlertShown = true;
            setTimeout(() => {
              alert(t('sidebar.team_readonly', '🔒 团队空间为只读模式'));
              (window as any).__teamReadOnlyAlertShown = false;
            }, 50);
          }
        }
      }}
    >
      <Editor
        initialContent={content}
        initialMetadata={metadata}
        onSave={(_path, _fid, _body, _meta, _opts) => { }}
        onTitleChange={() => { }}
        onNoteRenamed={async () => { }}
        isNewNote={false}
        shouldFocusBody={false}
        onNavigateToNote={() => { }}
        readOnly={true}
        activeNoteId={noteId}
      />
    </div>
  );
}
