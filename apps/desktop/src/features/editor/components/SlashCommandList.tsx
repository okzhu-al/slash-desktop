import { forwardRef, useEffect, useImperativeHandle, useState, createElement } from 'react';
import { Editor } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import * as Icons from 'lucide-react';
import { ChevronRight, CornerDownLeft } from 'lucide-react';

export interface SlashCommandListProps {
    items: any[];
    command: any;
    editor: Editor;
    query: string;
}

const DynamicIcon = ({ name, size = 16, className = '' }: { name: string, size?: number, className?: string }) => {
    const IconComponent = (Icons as any)[name] || Icons.Command;
    return createElement(IconComponent, { size, className });
};

export const SlashCommandList = forwardRef((props: SlashCommandListProps, ref) => {
    const { t } = useTranslation();
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [activeCategory, setActiveCategory] = useState<string | null>(null);

    // Reset drill-down and selection when query changes
    useEffect(() => {
        setActiveCategory(null);
        setSelectedIndex(0);
    }, [props.query]);

    // Compute derived list based on current state
    let renderItems: any[] = [];
    const cleanQuery = props.query.trimStart();

    if (cleanQuery) {
        // Spotlight mode: flat list of all matching items
        renderItems = props.items;
    } else if (activeCategory) {
        // Drill-down mode: "Back" + items in category
        const catItems = props.items.filter(i => i.category === activeCategory);
        renderItems = [{ id: 'back', isBack: true, title: t('slashCommands.back', '返回 (Back)') }, ...catItems];
    } else {
        // Root mode: distinct categories
        const cats = Array.from(new Set(props.items.map(i => i.category).filter(Boolean))) as string[];
        // For component mapping, we use static icons for major categories
        const catIcons: Record<string, string> = {
            'heading': 'Type',
            'formatting': 'Paintbrush',
            'list': 'ListCollapse',
            'block': 'LayoutTemplate',
            'component': 'Package',
            'ai': 'Sparkles'
        };
        renderItems = cats.map(c => ({ 
            id: `cat_${c}`, 
            isCategory: true, 
            title: t(`slashCommands.categories.${c}`, c),
            iconType: catIcons[c] || 'Folder',
            originalCategory: c
        }));
    }

    const maxIndex = renderItems.length;

    const selectItem = (index: number) => {
        if (index < 0 || index >= maxIndex) return;
        const item = renderItems[index];

        if (item.isCategory) {
            setActiveCategory(item.originalCategory);
            setSelectedIndex(0);
        } else if (item.isBack) {
            setActiveCategory(null);
            setSelectedIndex(0);
        } else {
            props.command(item);
        }
    };

    const upHandler = () => {
        if (maxIndex === 0) return;
        setSelectedIndex((selectedIndex + maxIndex - 1) % maxIndex);
    };

    const downHandler = () => {
        if (maxIndex === 0) return;
        setSelectedIndex((selectedIndex + 1) % maxIndex);
    };

    const enterHandler = () => {
        selectItem(selectedIndex);
    };

    useImperativeHandle(ref, () => ({
        onKeyDown: ({ event }: { event: KeyboardEvent }) => {
            if (event.key === 'ArrowUp') {
                upHandler();
                return true;
            }

            if (event.key === 'ArrowDown') {
                downHandler();
                return true;
            }

            if (event.key === 'ArrowRight') {
                const cur = renderItems[selectedIndex];
                if (cur?.isCategory) {
                    setActiveCategory(cur.originalCategory);
                    setSelectedIndex(0);
                    return true;
                }
            }

            if (event.key === 'ArrowLeft') {
                if (activeCategory && !cleanQuery) {
                    setActiveCategory(null);
                    setSelectedIndex(0);
                    return true;
                }
            }

            if (event.key === 'Enter') {
                enterHandler();
                return true;
            }

            return false;
        },
    }));

    // Get translated title for item
    const getItemTitle = (item: any) => {
        if (item.i18nKey) {
            const translated = t(item.i18nKey);
            if (translated !== item.i18nKey) return translated;
        }
        return item.title;
    };

    // Keep scroll position synced
    useEffect(() => {
        const selectedEl = document.getElementById(`slash-cmd-item-${selectedIndex}`);
        if (selectedEl) {
            selectedEl.scrollIntoView({ block: 'nearest' });
        }
    }, [selectedIndex, renderItems]);

    return (
        <div className="z-50 w-64 max-h-[320px] shadow-2xl overflow-y-auto rounded-lg border border-zinc-200/50 bg-white/95 dark:bg-zinc-800/95 backdrop-blur-xl p-1.5 text-zinc-800 dark:border-zinc-700/50 dark:text-zinc-200 animate-in fade-in zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out data-[state=closed]:zoom-out-95 font-sans">
            {!cleanQuery && !activeCategory && (
                <div className="px-2 py-1 mb-1 text-[10px] font-semibold tracking-wider text-zinc-400 dark:text-zinc-500 uppercase">
                    {t('slashCommands.commandsTitle', '功能导航 (Commands)')}
                </div>
            )}
            
            {!cleanQuery && activeCategory && (
                <div className="px-2 py-1 mb-1 text-[10px] font-semibold tracking-wider text-zinc-400 dark:text-zinc-500 uppercase flex items-center gap-1">
                    {t(`slashCommands.categories.${activeCategory}`, activeCategory)}
                </div>
            )}

            {renderItems.length ? (
                renderItems.map((item, index) => {
                    const isSelected = index === selectedIndex;
                    
                    return (
                        <button
                            id={`slash-cmd-item-${index}`}
                            key={item.id || index}
                            onClick={() => selectItem(index)}
                            onMouseEnter={() => setSelectedIndex(index)}
                            className={`flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-sm outline-none transition-colors 
                                ${isSelected 
                                    ? 'bg-blue-500 text-white dark:bg-blue-600' 
                                    : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700'
                                }`}
                        >
                            <div className={`flex items-center justify-center p-1 rounded-md ${isSelected ? 'bg-white/20' : 'bg-zinc-100 dark:bg-zinc-700'}`}>
                                {item.isBack ? (
                                    <CornerDownLeft size={14} className={isSelected ? 'text-white' : 'text-zinc-500 dark:text-zinc-400'} />
                                ) : (
                                    <DynamicIcon name={item.iconType || 'CircleDashed'} size={14} className={isSelected ? 'text-white' : 'text-zinc-500 dark:text-zinc-400'} />
                                )}
                            </div>
                            
                            <span className="flex-1 text-left font-medium truncate">
                                {getItemTitle(item)}
                            </span>

                            {item.shortcut && (
                                <kbd className={`ml-auto text-[10px] px-1.5 tracking-widest font-mono rounded ${isSelected ? 'bg-black/20 text-white/90' : 'bg-zinc-100 dark:bg-zinc-700 text-zinc-400'}`}>
                                    {item.shortcut}
                                </kbd>
                            )}
                            
                            {item.isCategory && (
                                <ChevronRight size={14} className={`ml-1 opacity-50 ${isSelected ? 'text-white' : ''}`} />
                            )}
                        </button>
                    )
                })
            ) : (
                <div className="px-3 py-4 text-center pb-2 text-sm text-zinc-500 dark:text-zinc-400 italic">
                    {t('slashCommands.noResult', '无匹配结果')}
                </div>
            )}
        </div>
    );
});

SlashCommandList.displayName = 'SlashCommandList';
