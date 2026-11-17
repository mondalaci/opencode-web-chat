import hljs from "highlight.js/lib/common"

/**
 * Highlighting for a tool summary that reads as a shell command.
 *
 * The bash grammar colours only the command names and their strings, which
 * leaves a summary row looking monochrome next to a code block. This module
 * runs the grammar and then colours the tokens it leaves plain — flags, URLs
 * and numbers — so a command reads as richly as the code around it.
 */

/** Beyond this, highlighting costs more than it is worth. */
const MAX_LINES = 3000

/**
 * Tokens the bash grammar leaves plain, mostly flags, URLs and numbers.
 *
 * These patterns are applied to the text the grammar left uncoloured, in order,
 * so a URL's digits stay part of the URL and a number inside a flag stays part
 * of the flag.
 */
const EXTRA_TOKENS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bhttps?:\/\/[^\s"'<>]+/g, "hljs-link"],
  [/(?<![\w-])--?[A-Za-z][\w-]*/g, "hljs-flag"],
  [/\b\d+(?:\.\d+)*\b/g, "hljs-number"],
]

/** Wrap the extra tokens in a single text node, leaving the markup intact. */
function decorateTextNode(node: Text): void {
  const text = node.textContent ?? ""
  const ranges: Array<{ start: number; end: number; cls: string }> = []

  for (const [pattern, cls] of EXTRA_TOKENS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0
      const end = start + match[0].length
      if (ranges.some((range) => start < range.end && end > range.start)) continue
      ranges.push({ start, end, cls })
    }
  }

  if (!ranges.length) return
  ranges.sort((a, b) => a.start - b.start)

  const fragment = document.createDocumentFragment()
  let cursor = 0
  for (const range of ranges) {
    if (range.start > cursor) fragment.append(text.slice(cursor, range.start))
    const span = document.createElement("span")
    span.className = range.cls
    span.textContent = text.slice(range.start, range.end)
    fragment.append(span)
    cursor = range.end
  }
  if (cursor < text.length) fragment.append(text.slice(cursor))
  node.replaceWith(fragment)
}

/**
 * Highlight a shell command for a summary row, adding the tokens the bash
 * grammar leaves plain so the row reads as colourfully as a code block.
 *
 * The result is not split per line: a summary is one row of text, and the
 * browser wraps it. Returns null when the command is too long to bother with.
 */
export function highlightShellSummary(code: string): string | null {
  const lineCount = code.length ? code.split("\n").length : 0
  if (lineCount > MAX_LINES) return null

  let html: string
  try {
    html = hljs.highlight(code, { language: "bash", ignoreIllegals: true }).value
  } catch {
    return null
  }

  const template = document.createElement("template")
  template.innerHTML = html
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text)
  for (const node of textNodes) {
    // The grammar's own spans already carry a colour; only plain text is ours.
    if (node.parentElement?.closest("span[class^='hljs-']")) continue
    decorateTextNode(node)
  }
  return template.innerHTML
}
