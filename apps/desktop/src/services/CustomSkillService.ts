/**
 * CustomSkillService.ts
 * 
 * Tauri 命令封装：管理和执行用户自定义 AI Skill
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

// ============================================================================
// Types
// ============================================================================

export interface DynamicSkillConfig {
    id: string;
    name: string;
    description?: string;
    system_prompt: string;
    max_output_tokens?: number;
    temperature?: number;
    input_mode?: 'selection' | 'full_note';
}

export interface SkillExecutionResult {
    skill_id: string;
    result?: string;
    error?: string;
    status: 'success' | 'error';
}

// ============================================================================
// API
// ============================================================================

/** 列出所有自定义 Skill */
export async function listCustomSkills(): Promise<DynamicSkillConfig[]> {
    return invoke<DynamicSkillConfig[]>('list_custom_skills');
}

/** 读取 Skill 的 YAML 原始内容 */
export async function loadCustomSkillYaml(skillId: string): Promise<string> {
    return invoke<string>('load_custom_skill_yaml', { skillId });
}

/** 保存/创建 Skill */
export async function saveCustomSkill(skillId: string, yamlContent: string): Promise<void> {
    return invoke<void>('save_custom_skill', { skillId, yamlContent });
}

/** 删除 Skill */
export async function deleteCustomSkill(skillId: string): Promise<void> {
    return invoke<void>('delete_custom_skill', { skillId });
}

/** 执行 Skill（异步，结果通过事件返回） */
export async function executeCustomSkill(skillId: string, content: string, notePath: string = ''): Promise<string> {
    return invoke<string>('execute_custom_skill', { skillId, content, notePath });
}

/** 监听 Skill 执行完成事件 */
export function onSkillCompleted(callback: (result: SkillExecutionResult) => void): Promise<UnlistenFn> {
    return listen<SkillExecutionResult>('custom-skill:completed', (event) => {
        callback(event.payload);
    });
}

/** 流式 chunk 事件 */
export interface SkillChunkEvent {
    skill_id: string;
    chunk: string;
}

/** 监听 Skill 流式 chunk 事件 */
export function onSkillChunk(callback: (event: SkillChunkEvent) => void): Promise<UnlistenFn> {
    return listen<SkillChunkEvent>('custom-skill:chunk', (ev) => {
        callback(ev.payload);
    });
}

// ============================================================================
// YAML Templates
// ============================================================================

import type { TFunction } from 'i18next';

/**
 * Build predefined skill templates with i18n support.
 * YAML content stays language-agnostic (system_prompt is for AI, not UI).
 * Only the display `name` and `description` are localized.
 */
export function getSkillTemplates(t: TFunction): Record<string, { config: DynamicSkillConfig; yaml: string }> {
    return {
        translate: {
            config: {
                id: 'translate_en',
                name: t('customSkills.tpl_translate_name', 'Translate to English'),
                description: t('customSkills.tpl_translate_desc', 'Translate selected text to natural English'),
                system_prompt: 'Translate the following text to natural English.\nOutput ONLY the translation, no explanation.',
                max_output_tokens: 1024,
            },
            yaml: `id: translate_en
name: "${t('customSkills.tpl_translate_name', 'Translate to English')}"
description: "${t('customSkills.tpl_translate_desc', 'Translate selected text to natural English')}"
system_prompt: |
  Translate the following text to natural English.
  Output ONLY the translation, no explanation.
max_output_tokens: 1024
temperature: 0.0
input_mode: selection`,
        },
        polish: {
            config: {
                id: 'polish',
                name: t('customSkills.tpl_polish_name', 'Polish Text'),
                description: t('customSkills.tpl_polish_desc', 'Optimize text expression to be more fluent and professional'),
                system_prompt: 'Polish the following text to make it more fluent, professional, and native-like. Keep the original meaning intact.\nCRITICAL: DO NOT translate the text. You MUST keep the exact original language (e.g., if the input is Chinese, output in Chinese).\nOutput ONLY the polished text.',
            },
            yaml: `id: polish
name: "${t('customSkills.tpl_polish_name', 'Polish Text')}"
description: "${t('customSkills.tpl_polish_desc', 'Optimize text expression to be more fluent and professional')}"
system_prompt: |
  Polish the following text to make it more fluent, professional, and native-like. Keep the original meaning intact.
  CRITICAL: DO NOT translate the text. You MUST keep the exact original language (e.g., if the input is Chinese, output in Chinese).
  Output ONLY the polished text.
max_output_tokens: 1024
temperature: 0.3
input_mode: selection`,
        },
        mermaid: {
            config: {
                id: 'gen_mermaid',
                name: t('customSkills.tpl_mermaid_name', 'Generate Mermaid Chart'),
                description: t('customSkills.tpl_mermaid_desc', 'Generate a flowchart or architecture diagram based on the content'),
                system_prompt: 'Generate a Mermaid flowchart to visualize the relationships in the following content.\n**STRICT SYNTAX REQUIREMENTS**:\n1. You MUST put a line break between `subgraph` declaration and its internal nodes.\n2. NEVER write inline subgraphs like `subgraph A Node(B)`.\n3. The `subgraph` ID MUST be alphanumeric only (NO spaces or parentheses). To add a descriptive label with spaces, use `subgraph ID ["Label with spaces"]`.\n4. CRITICAL: DO NOT translate node labels. You MUST keep the exact original language (e.g., Chinese stays Chinese) for all descriptions.\nOutput ONLY the mermaid code block starting with ```mermaid, no explanations.',
            },
            yaml: `id: gen_mermaid
name: "${t('customSkills.tpl_mermaid_name', 'Generate Mermaid Chart')}"
description: "${t('customSkills.tpl_mermaid_desc', 'Generate a flowchart or architecture diagram based on the content')}"
system_prompt: |
  Generate a Mermaid flowchart to visualize the relationships in the following content.
  **STRICT SYNTAX REQUIREMENTS**:
  1. You MUST put a line break between \`subgraph\` declaration and its internal nodes. For example:
     WRONG: \`subgraph A Node(B)\`
     CORRECT:
     subgraph A
         Node(B)
     end
  2. Node definitions (e.g., \`A(Text)\`) and connections MUST have proper line breaks or clear structure.
  3. The \`subgraph\` ID MUST be alphanumeric only (NO spaces, NO parentheses). To add a descriptive label with spaces or parentheses, you MUST use quotes and brackets: \`subgraph ID ["Label (extra)"]\`. 
     WRONG: \`subgraph 前端层 (Tauri)\`
     CORRECT: \`subgraph Frontend ["前端层 (Tauri)"]\`
  4. CRITICAL: DO NOT translate node labels. You MUST keep the exact original language (e.g., Chinese stays Chinese) for all descriptions.
  Output ONLY the mermaid code block starting with \`\`\`mermaid, no explanations.
max_output_tokens: 1024
temperature: 0.0
input_mode: selection`,
        },
    };
}

/**
 * Build default YAML template for "New Skill" with i18n support.
 */
export function getDefaultSkillYaml(t: TFunction): string {
    return `id: ${t("customSkills.default_yaml_id", "my_skill")}
name: "${t("customSkills.default_yaml_name", "My Skill")}"
description: "${t("customSkills.default_yaml_desc", "Describe what this skill does")}"
system_prompt: |
  ${t("customSkills.default_yaml_prompt", "You are a helpful assistant.\\nProcess user text and return improved content.\\nCRITICAL: DO NOT translate the text. You MUST keep the exact original language (e.g., if the input is Chinese, output in Chinese) unless explicitly requested.")}
  # ${t("customSkills.default_syntax_hint", "Hint: You can instruct AI to output in Markdown formats like **bold**, *italic*, `code`, schemas, or ```mermaid diagrams.")}
input_mode: selection
output_format: text
max_tokens: 1024
temperature: 0.7
`;
}

/**
 * Flat template list for UI rendering. Requires `t` for localization.
 */
export function getPredefinedTemplates(t: TFunction): { id: string; name: string; description: string; yaml: string }[] {
    return Object.values(getSkillTemplates(t)).map(({ config, yaml }) => ({
        id: config.id,
        name: config.name,
        description: config.description || '',
        yaml,
    }));
}

// Legacy exports for backward compatibility (uses fallback Chinese)
export const SKILL_TEMPLATES = getSkillTemplates(((_key: string, fallback: string) => fallback) as unknown as TFunction);
export const PREDEFINED_TEMPLATES = getPredefinedTemplates(((_key: string, fallback: string) => fallback) as unknown as TFunction);

