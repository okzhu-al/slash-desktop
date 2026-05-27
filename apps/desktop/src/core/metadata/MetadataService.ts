import matter from 'gray-matter';

export interface FileMetadata {
    title?: string;
    tags?: string[];
    starred?: boolean;
    created?: number;
    updated?: number;
    [key: string]: any;
}

export interface ParseResult {
    metadata: FileMetadata;
    content: string;
    frontmatter: string;
}

class MetadataService {
    private cache: Map<string, FileMetadata> = new Map();

    /**
     * Parse content to extract frontmatter and body.
     * Updates the cache.
     */
    parse(path: string, rawContent: string): ParseResult {
        try {
            const result = matter(rawContent);
            const metadata = result.data as FileMetadata;
            this.cache.set(path, metadata);
            // result.matter contains the raw frontmatter content (without delimiters)
            return { metadata, content: result.content, frontmatter: result.matter };
        } catch (e) {
            console.warn(`Failed to parse metadata for ${path}`, e);
            return { metadata: {}, content: rawContent, frontmatter: '' };
        }
    }

    /**
     * Stringify content with metadata to YAML frontmatter format.
     * Filters out undefined values that would cause YAML serialization errors.
     */
    stringify(content: string, metadata: FileMetadata): string {
        // Filter out undefined values that can't be serialized by YAML
        const cleanedMetadata: Record<string, any> = {};
        for (const [key, value] of Object.entries(metadata)) {
            if (value !== undefined) {
                cleanedMetadata[key] = value;
            }
        }

        // Clean content - remove any leading newlines
        const cleanedContent = content.replace(/^[\n\r]+/, '');

        // Use gray-matter to stringify
        let result = matter.stringify(cleanedContent, cleanedMetadata);

        // Ensure frontmatter exists (gray-matter may skip it for empty objects)
        if (!result.startsWith('---')) {
            result = `---\n---\n${result}`;
        }

        return result;
    }

    /**
     * Helper to get clean YAML content without delimiters.
     * Filters out undefined values that would cause YAML serialization errors.
     */
    cleanFrontmatter(metadata: FileMetadata): string {
        // Filter out undefined values that can't be serialized by YAML
        const cleanedMetadata: Record<string, any> = {};
        for (const [key, value] of Object.entries(metadata)) {
            if (value !== undefined) {
                cleanedMetadata[key] = value;
            }
        }
        const stringified = matter.stringify('', cleanedMetadata);
        return stringified.replace(/^---\n/, '').replace(/---\n$/, '').trim();
    }

    /**
     * Get cached metadata for a path.
     */
    getCached(path: string): FileMetadata | undefined {
        return this.cache.get(path);
    }

    /**
     * Update specific metadata key for a file content.
     * Returns the new full file content string.
     */
    updateMetadata(rawContent: string, updates: Partial<FileMetadata>): string {
        const { data, content } = matter(rawContent);
        const newMetadata = { ...data, ...updates };
        return this.stringify(content, newMetadata);
    }

    /**
     * 确保文件 YAML frontmatter 中包含 slash_id。
     * 如果已有 slash_id 则原样返回；是否则自动注入新 UUID 并返回更新后的内容。
     * 调用时机：在 Slash 中首次创建/首次保存笔记时调用。
     */
    ensureSlashId(rawContent: string): string {
        try {
            const result = matter(rawContent);
            if (result.data.slash_id) {
                return rawContent; // 已有 UUID，不需要操作
            }
            const newId = crypto.randomUUID();
            const newMetadata = { slash_id: newId, ...result.data };
            return this.stringify(result.content, newMetadata);
        } catch (e) {
            // 解析失败时不强制注入，返回原内容
            return rawContent;
        }
    }

    clearCache(path?: string) {
        if (path) {
            this.cache.delete(path);
        } else {
            this.cache.clear();
        }
    }
}

export const metadataService = new MetadataService();
