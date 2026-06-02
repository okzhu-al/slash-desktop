/**
 * CustomSkillsTab.tsx
 *
 * 自定义 AI Skill 管理面板。
 * - 列表展示已有 Skills
 * - 新建/编辑 YAML 配置
 * - 从预置模板快速创建
 * - 删除 Skill
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Edit3, ChevronDown, ChevronRight, ChevronUp, Sparkles, FileCode, X } from 'lucide-react';
import { cn } from '@/shared/utils/cn';
import {
    listCustomSkills,
    loadCustomSkillYaml,
    saveCustomSkill,
    deleteCustomSkill,
    DynamicSkillConfig,
    getPredefinedTemplates,
    getDefaultSkillYaml,
} from '@/services/CustomSkillService';

// ============================================================================
// Sub Components
// ============================================================================

function YamlEditor({
    value,
    onChange,
}: {
    value: string;
    onChange: (v: string) => void;
}) {
    return (
        <textarea
            lang="zh-Hans"
            className={cn(
                "w-full h-64 px-3 py-2 rounded-lg text-sm",
                "bg-zinc-50 dark:bg-zinc-800/50",
                "border border-zinc-200 dark:border-zinc-700",
                "text-zinc-800 dark:text-zinc-200",
                "placeholder:text-zinc-400 dark:placeholder:text-zinc-500",
                "focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:focus:ring-blue-400/20 focus:border-indigo-400 dark:focus:border-blue-400/60",
                "resize-y"
            )}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
        />
    );
}

/** Inline editor panel rendered below a skill card */
function InlineEditorPanel({
    editingId,
    isNew,
    yamlContent,
    setYamlContent,
    error,
    saving,
    onSave,
    onCancel,
    editorRef,
}: {
    editingId: string;
    isNew: boolean;
    yamlContent: string;
    setYamlContent: (v: string) => void;
    error: string | null;
    saving: boolean;
    onSave: () => void;
    onCancel: () => void;
    editorRef: React.RefObject<HTMLDivElement | null>;
}) {
    const { t } = useTranslation();

    return (
        <div
            ref={editorRef}
            className="ml-2 pl-4 border-l-2 border-indigo-400/50 dark:border-blue-400/40 space-y-3 py-3 animate-in slide-in-from-top-2 duration-200"
        >
            <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    {isNew
                        ? t('customSkills.new_title', '新建 Skill')
                        : t('customSkills.edit_title', '编辑 Skill: {{id}}', { id: editingId })}
                </h4>
                <button
                    onClick={onCancel}
                    className="p-1 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                >
                    <X size={14} />
                </button>
            </div>
            <YamlEditor value={yamlContent} onChange={setYamlContent} />
            {error && (
                <p className="text-sm text-red-500">{error}</p>
            )}
            <div className="flex gap-2">
                <button
                    onClick={onSave}
                    disabled={saving}
                    className={cn(
                        "px-4 py-1.5 rounded-lg text-sm font-medium",
                        "bg-indigo-500 text-white hover:bg-indigo-600",
                        "disabled:opacity-50 disabled:cursor-not-allowed",
                        "transition-colors"
                    )}
                >
                    {saving
                        ? t('customSkills.saving', '保存中...')
                        : t('customSkills.save', '保存')}
                </button>
                <button
                    onClick={onCancel}
                    className={cn(
                        "px-4 py-1.5 rounded-lg text-sm font-medium",
                        "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400",
                        "hover:bg-zinc-200 dark:hover:bg-zinc-700",
                        "transition-colors"
                    )}
                >
                    {t('customSkills.cancel', '取消')}
                </button>
            </div>
        </div>
    );
}

// ============================================================================
// Main Component
// ============================================================================

export function CustomSkillsTab() {
    const { t } = useTranslation();

    // ── State ──
    const [skills, setSkills] = useState<DynamicSkillConfig[]>([]);
    const [loading, setLoading] = useState(true);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [yamlContent, setYamlContent] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showTemplates, setShowTemplates] = useState(false);
    const [isNew, setIsNew] = useState(false);

    const editorRef = useRef<HTMLDivElement | null>(null);

    // ── Auto-scroll to editor when it opens ──
    useEffect(() => {
        if (editingId && editorRef.current) {
            // Small delay to let animation start
            setTimeout(() => {
                editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }, 50);
        }
    }, [editingId]);

    // ── Load skills ──
    const loadSkills = useCallback(async () => {
        setLoading(true);
        try {
            const list = await listCustomSkills();
            setSkills(list);
        } catch (e) {
            console.error('[CustomSkillsTab] Failed to load skills:', e);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadSkills();
    }, [loadSkills]);

    // ── Handlers ──
    const handleEdit = async (skillId: string) => {
        // Toggle: if already editing this skill, close it
        if (editingId === skillId) {
            setEditingId(null);
            setIsNew(false);
            setError(null);
            return;
        }
        try {
            const yaml = await loadCustomSkillYaml(skillId);
            setYamlContent(yaml);
            setEditingId(skillId);
            setIsNew(false);
            setError(null);
        } catch (e) {
            console.error('[CustomSkillsTab] Failed to load YAML:', e);
        }
    };

    const handleNew = () => {
        setYamlContent(getDefaultSkillYaml(t));
        setEditingId('__new__');
        setIsNew(true);
        setError(null);
    };

    const handleUseTemplate = (templateYaml: string) => {
        setYamlContent(templateYaml);
        setEditingId('__new__');
        setIsNew(true);
        setError(null);
        setShowTemplates(false);
    };

    const handleSave = async () => {
        setSaving(true);
        setError(null);
        try {
            // 从 YAML 中提取 id
            const idMatch = yamlContent.match(/^id:\s*(.+)$/m);
            if (!idMatch) {
                setError(t('customSkills.error_no_id', 'YAML 缺少 id 字段'));
                setSaving(false);
                return;
            }
            const skillId = idMatch[1].trim();
            await saveCustomSkill(skillId, yamlContent);
            setEditingId(null);
            setIsNew(false);
            await loadSkills();
        } catch (e: any) {
            setError(e?.toString() || 'Save failed');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (skillId: string) => {
        try {
            await deleteCustomSkill(skillId);
            if (editingId === skillId) {
                setEditingId(null);
            }
            await loadSkills();
        } catch (e) {
            console.error('[CustomSkillsTab] Failed to delete:', e);
        }
    };

    const handleCancel = () => {
        setEditingId(null);
        setIsNew(false);
        setError(null);
    };

    // ── Render ──
    return (
        <div className="space-y-6">
            {/* Header */}
            <div>
                <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                    <Sparkles size={16} className="text-indigo-500 dark:text-blue-400" />
                    {t('customSkills.title', '自定义 AI Skills')}
                </h3>
                <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                    {t('customSkills.desc', '通过 YAML 定义自定义 AI 技能，在编辑器中使用。')}
                </p>
            </div>

            {/* Action Bar */}
            <div className="flex gap-2">
                <button
                    onClick={handleNew}
                    className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium",
                        "bg-indigo-500 text-white hover:bg-indigo-600",
                        "transition-colors"
                    )}
                >
                    <Plus size={14} />
                    {t('customSkills.new', '新建')}
                </button>
                <button
                    onClick={() => setShowTemplates(!showTemplates)}
                    className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium",
                        "bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300",
                        "hover:bg-zinc-200 dark:hover:bg-zinc-700",
                        "transition-colors"
                    )}
                >
                    <FileCode size={14} />
                    {t('customSkills.templates', '模板')}
                    {showTemplates ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
            </div>

            {/* Templates Drawer */}
            {showTemplates && (
                <div className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/30 space-y-2">
                    <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
                        {t('customSkills.template_hint', '选择一个模板快速开始')}
                    </p>
                    {getPredefinedTemplates(t).map((tpl) => (
                        <button
                            key={tpl.id}
                            onClick={() => handleUseTemplate(tpl.yaml)}
                            className={cn(
                                "w-full text-left px-3 py-2 rounded-lg",
                                "hover:bg-zinc-100 dark:hover:bg-zinc-700",
                                "transition-colors group"
                            )}
                        >
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                                    ⚡ {tpl.name}
                                </span>
                            </div>
                            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                                {tpl.description}
                            </p>
                        </button>
                    ))}
                </div>
            )}

            {/* ── New Skill Editor (at top, before list) ── */}
            {editingId === '__new__' && isNew && (
                <InlineEditorPanel
                    editingId={editingId}
                    isNew={isNew}
                    yamlContent={yamlContent}
                    setYamlContent={setYamlContent}
                    error={error}
                    saving={saving}
                    onSave={handleSave}
                    onCancel={handleCancel}
                    editorRef={editorRef}
                />
            )}

            {/* Skill List — each card followed by its inline editor */}
            {loading ? (
                <div className="text-sm text-zinc-400 py-4 text-center">
                    {t('common.loading', '加载中...')}
                </div>
            ) : skills.length === 0 && !editingId ? (
                <div className="text-sm text-zinc-400 dark:text-zinc-500 py-8 text-center">
                    {t('customSkills.empty', '还没有自定义 Skill，点击上方按钮创建。')}
                </div>
            ) : (
                <div className="space-y-2">
                    {skills.map((skill) => (
                        <div key={skill.id}>
                            {/* Skill Card */}
                            <div
                                className={cn(
                                    "flex items-center justify-between px-4 py-3 rounded-lg",
                                    "border border-zinc-200 dark:border-zinc-700",
                                    "bg-white dark:bg-zinc-800/50",
                                    editingId === skill.id && "ring-2 ring-indigo-500 dark:ring-blue-400/30 border-indigo-300 dark:border-blue-400/50"
                                )}
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                                            ⚡ {skill.name}
                                        </span>
                                        <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400">
                                            {skill.id}
                                        </span>
                                    </div>
                                    {skill.description && (
                                        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 truncate">
                                            {skill.description}
                                        </p>
                                    )}
                                </div>
                                <div className="flex items-center gap-1 ml-2">
                                    <button
                                        onClick={() => handleEdit(skill.id)}
                                        className={cn(
                                            "p-1.5 rounded-md transition-colors",
                                            editingId === skill.id
                                                ? "text-indigo-500 dark:text-blue-400 bg-indigo-50 dark:bg-indigo-900/30"
                                                : "text-zinc-400 hover:text-indigo-500 dark:hover:text-blue-300 hover:bg-zinc-100 dark:hover:bg-zinc-700"
                                        )}
                                        title={t('customSkills.edit', '编辑')}
                                    >
                                        {editingId === skill.id ? <ChevronUp size={14} /> : <Edit3 size={14} />}
                                    </button>
                                    <button
                                        onClick={() => handleDelete(skill.id)}
                                        className="p-1.5 rounded-md text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                                        title={t('customSkills.delete_btn', '删除')}
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            </div>

                            {/* Inline editor — appears directly below this card */}
                            {editingId === skill.id && !isNew && (
                                <InlineEditorPanel
                                    editingId={editingId}
                                    isNew={false}
                                    yamlContent={yamlContent}
                                    setYamlContent={setYamlContent}
                                    error={error}
                                    saving={saving}
                                    onSave={handleSave}
                                    onCancel={handleCancel}
                                    editorRef={editorRef}
                                />
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
