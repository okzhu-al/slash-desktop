import { forwardRef, useEffect, useImperativeHandle, useState, useRef } from 'react';
import { SuggestionKeyDownProps } from '@tiptap/suggestion';
import { FileText } from 'lucide-react';

export interface WikiLinkItem {
    id: string;
    title: string;
    path: string;
}

export interface WikiLinkListProps {
    items: WikiLinkItem[];
    command: (item: WikiLinkItem) => void;
}

export interface WikiLinkListRef {
    onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

const WikiLinkList = forwardRef<WikiLinkListRef, WikiLinkListProps>(
    ({ items, command }, ref) => {
        const [selectedIndex, setSelectedIndex] = useState(0);
        const containerRef = useRef<HTMLDivElement>(null);

        // Reset selection when items change
        useEffect(() => {
            setSelectedIndex(0);
        }, [items]);

        // Keep selected item in view
        useEffect(() => {
            if (!containerRef.current) return;
            const buttons = containerRef.current.querySelectorAll('button');
            const selectedButton = buttons[selectedIndex];
            if (selectedButton) {
                selectedButton.scrollIntoView({ block: 'nearest' });
            }
        }, [selectedIndex]);

        const selectItem = (index: number) => {
            const item = items[index];
            if (item) {
                command(item);
            }
        };

        useImperativeHandle(ref, () => ({
            onKeyDown: ({ event }: SuggestionKeyDownProps) => {
                if (event.key === 'ArrowUp') {
                    setSelectedIndex((prev) => (prev + items.length - 1) % items.length);
                    return true;
                }

                if (event.key === 'ArrowDown') {
                    setSelectedIndex((prev) => (prev + 1) % items.length);
                    return true;
                }

                if (event.key === 'Enter') {
                    selectItem(selectedIndex);
                    return true;
                }

                return false;
            },
        }));

        if (items.length === 0) {
            return (
                <div className="p-3 text-sm text-zinc-400 dark:text-zinc-500">
                    No notes found
                </div>
            );
        }

        return (
            <div
                ref={containerRef}
                className="wiki-link-list bg-white dark:bg-zinc-800 rounded-lg shadow-xl border border-zinc-200 dark:border-zinc-700"
                style={{ maxHeight: 320, overflowY: 'auto', width: 320 }}
            >
                {items.map((item, index) => {
                    const isSelected = index === selectedIndex;
                    const folder = item.path.includes('/')
                        ? item.path.split('/').slice(0, -1).join('/')
                        : '';

                    return (
                        <button
                            key={item.id}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => selectItem(index)}
                            className={`
                w-full text-left px-3 py-2 flex items-start gap-2 transition-colors
                ${isSelected
                                    ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-blue-300'
                                    : 'hover:bg-zinc-50 dark:hover:bg-zinc-700/50 text-zinc-700 dark:text-zinc-300'
                                }
              `}
                        >
                            <FileText
                                size={16}
                                className={`mt-0.5 shrink-0 ${isSelected ? 'text-indigo-500 dark:text-blue-400' : 'text-zinc-400'}`}
                            />
                            <div className="min-w-0 flex-1">
                                <div className="font-medium text-sm truncate">
                                    {item.title}
                                </div>
                                {folder && (
                                    <div className="text-xs text-zinc-400 dark:text-zinc-500 truncate">
                                        {folder}
                                    </div>
                                )}
                            </div>
                        </button>
                    );
                })}
            </div>
        );
    }
);

WikiLinkList.displayName = 'WikiLinkList';

export default WikiLinkList;
