/**
 * Sanitizes a string to be used as a filename.
 * Removes characters that are illegal in file systems (Windows/Unix).
 * Replaces illegal characters with a space or empty string.
 */
export const sanitizeFilename = (name: string): string => {
    // Windows illegal: < > : " / \ | ? *
    // Unix: / (and null byte)
    // We replace them with nothing or space.
    // Also trim.
    return name
        .replace(/[<>:"/\\|?*]/g, '') // Remove illegal chars
        .trim();
};
