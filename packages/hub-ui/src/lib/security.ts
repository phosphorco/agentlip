/**
 * Security utilities for safe rendering
 */

const ID_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate that a string is safe to use as an HTML ID or URL component
 */
export function isValidId(id: string): boolean {
  return typeof id === "string" && ID_REGEX.test(id);
}

/**
 * Validate URL for safe link rendering
 */
export function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Create a safe text node (never use innerHTML)
 */
export function safeText(text: string): Text {
  return document.createTextNode(text);
}

/**
 * Escape text content for safe display
 * Note: Always prefer textContent over innerHTML, but this is for
 * cases where we need to manually construct text
 */
export function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
