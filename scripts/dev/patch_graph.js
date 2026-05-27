const fs = require('fs');
const path = require('path');

const file = path.join('apps', 'desktop', 'src', 'features', 'graph', 'KnowledgeGraphPage.tsx');
let code = fs.readFileSync(file, 'utf8');

// Replace NewNodeInput interface and component
code = code.replace(
    /interface NewNodeInputProps \{[\s\S]*?function NewNodeInput[\s\S]*?return \([\s\S]*?\n\}/,
`interface NewNodeInputProps {
    position: { x: number; y: number };
    initialFolder: string;
    folders: string[];
    showRelation: boolean;
    onSubmit: (title: string, folder: string, relation?: string) => void;
    onCancel: () => void;
}

function NewNodeInput({ position, initialFolder, folders, showRelation, onSubmit, onCancel }: NewNodeInputProps) {
    const [title, setTitle] = useState('');
    const [folder, setFolder] = useState(initialFolder || '00_Inbox');
    const [relation, setRelation] = useState('related'); // Default relation
    const inputRef = useRef<HTMLInputElement>(null);
    const { t } = useTranslation();

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && title.trim()) {
            onSubmit(title.trim(), folder, showRelation ? relation : undefined);
        } else if (e.key === 'Escape') {
            onCancel();
        }
    };

    return (
        <div
            className="fixed z-[100] bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700
                       rounded-lg shadow-xl p-3 min-w-[200px]"
            style={{ left: position.x, top: position.y }}
        >
            <div className="text-[11px] text-zinc-400 mb-1.5">{t('graph.new_note', '创建新笔记')}</div>
            <input
                ref={inputRef}
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('graph.note_title_placeholder', '输入笔记标题...')}
                className="w-full px-2 py-1.5 text-sm border rounded-md mb-2
                           bg-zinc-50 dark:bg-zinc-700 border-zinc-300 dark:border-zinc-600
                           focus:outline-none focus:ring-2 focus:ring-indigo-500
                           text-zinc-800 dark:text-zinc-200"
            />
            
            <select
                value={folder}
                onChange={e => setFolder(e.target.value)}
                className="w-full px-2 py-1 text-xs border rounded-md mb-2 bg-zinc-50 dark:bg-zinc-700 border-zinc-300 dark:border-zinc-600 text-zinc-800 dark:text-zinc-200"
            >
                {folders.map(f => <option key={f} value={f}>{f}</option>)}
            </select>

            {showRelation && (
                <select
                    value={relation}
                    onChange={e => setRelation(e.target.value)}
                    className="w-full px-2 py-1 text-xs border rounded-md mb-2 bg-zinc-50 dark:bg-zinc-700 border-zinc-300 dark:border-zinc-600 text-zinc-800 dark:text-zinc-200"
                >
                    {RELATION_GROUPS.flatMap(g => g.keys).map(r => (
                        <option key={r} value={r}>{t(\`relations.\${r}\`, r)}</option>
                    ))}
                </select>
            )}

            <div className="flex gap-1.5">
                <button
                    onClick={() => title.trim() && onSubmit(title.trim(), folder, showRelation ? relation : undefined)}
                    className="flex-1 px-2 py-1 text-xs bg-indigo-500 text-white rounded hover:bg-indigo-600 transition-colors"
                >
                    {t('common.create', '创建')}
                </button>
                <button
                    onClick={onCancel}
                    className="px-2 py-1 text-xs bg-zinc-200 dark:bg-zinc-600 rounded
                               hover:bg-zinc-300 dark:hover:bg-zinc-500 transition-colors
                               text-zinc-600 dark:text-zinc-300"
                >
                    {t('common.cancel', '取消')}
                </button>
            </div>
        </div>
    );
}`
);

// Add folders useMemo and edit new node states
code = code.replace(
    /const vaultPath = useFileSystemStore\(state => state\.root\?\.path\);/,
    \`const root = useFileSystemStore(state => state.root);
    const vaultPath = root?.path;\`
);

code = code.replace(
    /const \[newNodeInput, setNewNodeInput\] = useState<\{[\s\S]*?\} \| null>\(null\);/,
    \`const [newNodeInput, setNewNodeInput] = useState<{
        position: { x: number; y: number };
        flowPosition: { x: number; y: number };
        parentNodeId?: string;  // If creating a child node
        initialFolder: string;
    } | null>(null);

    const folders = useMemo(() => {
        const result: string[] = ['00_Inbox'];
        if (!root) return result;
        const traverse = (node: any) => {
            if (node.is_dir && node.path !== root.path) {
                const rel = getRelativePath(node.path, root.path).replace(/\\\\/g, '/');
                if (!result.includes(rel)) result.push(rel);
            }
            if (node.children) node.children.forEach(traverse);
        };
        root.children?.forEach(traverse);
        return result.sort((a,b) => a.localeCompare(b));
    }, [root]);\`
);

code = code.replace(
    /setNewNodeInput\(\{ position: screenPos, flowPosition: flowPos \}\);/,
    \`setNewNodeInput({ position: screenPos, flowPosition: flowPos, initialFolder: '00_Inbox' });\`
);

code = code.replace(
    /const handler = \(e: Event\) => \{[^]*?parentNodeId: nodeId,\n.*?\}\);/,
    \`const handler = (e: Event) => {
            const { nodeId, screenX, screenY } = (e as CustomEvent).detail;
            const flowPos = screenToFlowPosition({ x: screenX, y: screenY + 80 });
            
            const idx = nodeId.lastIndexOf('/');
            const parentUrl = idx === -1 ? '' : nodeId.substring(0, idx);
            const defaultFolder = parentUrl || '00_Inbox';
            
            setNewNodeInput({
                position: { x: screenX, y: screenY },
                flowPosition: flowPos,
                parentNodeId: nodeId,
                initialFolder: defaultFolder,
            });\`
);

code = code.replace(
    /const handleCreateNode = useCallback\(async \(title: string\) => \{[^]*?\}\);[^]*?\}\);[^]*?\}\);[^]*?\} catch \(e\) \{/,
    \`const handleCreateNode = useCallback(async (title: string, folder: string, relation?: string) => {
        if (!newNodeInput || !vaultPath) return;
        const flowPos = newNodeInput.flowPosition;
        const parentNodeId = newNodeInput.parentNodeId;
        setNewNodeInput(null);

        try {
            // Create note using the standard repository
            const repo = new FileSystemNoteRepository(vaultPath);
            const parentDirectory = folder ? \`\${vaultPath}/\${folder}\` : \`\${vaultPath}/00_Inbox\`;
            const newNote = await repo.createNote(title, parentDirectory);

            // Compute the relative path, which is used as the node ID
            const newNodeId = getRelativePath(newNote.path, vaultPath).replace(/\\\\/g, '/');

            // Add node at click position
            const newNode: Node<KnowledgeNodeData> = {
                id: newNodeId,
                type: 'noteNode',
                position: flowPos,
                data: {
                    label: title,
                    tags: [],
                    category: 'inbox',
                    exists: true,
                    isCenter: false,
                    inDegree: 0,
                    nodeType: 'note',
                    noteCount: 0,
                    summary: null,
                    isNew: true, // Draft status
                    notePath: newNodeId,
                },
            };
            setNodes(nds => [...nds, newNode]);

            // If creating a child node, auto-create edge with 'related' relation
            if (parentNodeId && relation) {
                const newEdge: Edge<KnowledgeEdgeData> = {
                    id: \`e-\${parentNodeId}-\${newNodeId}-child\`,
                    source: parentNodeId,
                    target: newNodeId,
                    type: 'relationEdge',
                    data: { label: relation, linkType: 'yaml' },
                };
                setEdges(eds => addEdge(newEdge, eds));

                // Persist relation
                try {
                    await invoke('add_note_relation', {
                        vaultPath,
                        notePath: parentNodeId,
                        relation,
                        targetTitle: title,
                        targetPath: newNodeId,
                    });
                } catch (e) {
                    console.error('[KnowledgeGraph] Failed to add child relation:', e);
                }
            }
        } catch (e) {\`
);

code = code.replace(
    /<NewNodeInput\n?\s+position=\{newNodeInput\.position\}\n?\s+onSubmit=\{handleCreateNode\}\n?\s+onCancel=\{\(\) => setNewNodeInput\(null\)\}\n?\s+\/>/,
    \`<NewNodeInput
                    position={newNodeInput.position}
                    initialFolder={newNodeInput.initialFolder}
                    folders={folders}
                    showRelation={!!newNodeInput.parentNodeId}
                    onSubmit={handleCreateNode}
                    onCancel={() => setNewNodeInput(null)}
                />\`
);

fs.writeFileSync(file, code);
