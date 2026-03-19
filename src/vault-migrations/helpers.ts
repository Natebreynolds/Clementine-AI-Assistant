/**
 * Vault migration helpers — reusable content manipulation utilities.
 */

/** Check whether a markdown heading (## level) exists in the content. */
export function hasSection(content: string, heading: string): boolean {
  // Match ## Heading or ### Heading at start of line
  const pattern = new RegExp(`^#{2,3}\\s+${escapeRegex(heading)}\\s*$`, 'm');
  return pattern.test(content);
}

/** Append a section at the end of the file content. */
export function appendSection(content: string, section: string): string {
  const trimmed = content.trimEnd();
  return trimmed + '\n\n' + section + '\n';
}

/**
 * Insert a section after a specific heading's content block.
 * Finds the heading, then looks for the next heading at the same or higher level,
 * and inserts the new content before it. Falls back to appending if heading not found.
 */
export function insertSectionAfter(content: string, afterHeading: string, section: string): string {
  // Find the heading line
  const headingPattern = new RegExp(`^(#{2,3})\\s+${escapeRegex(afterHeading)}\\s*$`, 'm');
  const match = headingPattern.exec(content);

  if (!match) {
    // Heading not found — append at end
    return appendSection(content, section);
  }

  const headingLevel = match[1].length; // number of # chars
  const afterHeadingPos = match.index + match[0].length;

  // Find the next heading at the same or higher (fewer #) level
  const nextHeadingPattern = new RegExp(`^#{2,${headingLevel}}\\s+`, 'm');
  const rest = content.slice(afterHeadingPos);
  const nextMatch = nextHeadingPattern.exec(rest);

  if (nextMatch) {
    const insertPos = afterHeadingPos + nextMatch.index;
    return content.slice(0, insertPos) + section + '\n\n' + content.slice(insertPos);
  }

  // No following heading — append at end
  return appendSection(content, section);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
