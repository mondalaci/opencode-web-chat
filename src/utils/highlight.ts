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
 * The start of a here-document, e.g. `<<'EOF'` or `<<-DELIM`. The delimiter is
 * the part that ends the body.
 */
const HEREDOC_START = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/g

/**
 * A run of a command: either shell to highlight, or a here-document body, which
 * is data and is left alone.
 */
interface Segment {
  code: boolean
  text: string
}

/** Escape text so it can be handed to `v-html` exactly as it stands. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * Split a command into the runs of shell and the here-document bodies it feeds.
 *
 * The bash grammar has no notion of a here-document, so it reads the body as
 * more script — which paints `for`, `in` and `then` inside a commit message as
 * keywords, in the middle of ordinary prose. Cutting the bodies out keeps the
 * grammar on the code that really is code.
 *
 * A `<<` that never gets its delimiter line (one inside a quoted string, say) is
 * no here-document at all, so the rest of the command goes back to being code.
 * The runs join back with newlines into the command exactly as it was given.
 */
function commandSegments(code: string): Segment[] {
  const segments: Segment[] = []
  const codeLines: string[] = []
  let bodyLines: string[] | null = null
  const delimiters: string[] = []

  const endCode = () => {
    if (!codeLines.length) return
    segments.push({ code: true, text: codeLines.join("\n") })
    codeLines.length = 0
  }
  const endBody = () => {
    if (!bodyLines?.length) {
      bodyLines = null
      return
    }
    segments.push({ code: false, text: bodyLines.join("\n") })
    bodyLines = null
  }

  for (const line of code.split("\n")) {
    if (bodyLines) {
      if (line.trim() !== delimiters[0]) {
        bodyLines.push(line)
        continue
      }
      // The delimiter line is shell again, and ends the body.
      delimiters.shift()
      endBody()
      codeLines.push(line)
      // A command can open several here-documents at once; their bodies follow
      // one after the other.
      if (delimiters.length) {
        endCode()
        bodyLines = []
      }
      continue
    }

    codeLines.push(line)
    const starts = [...line.matchAll(HEREDOC_START)]
    if (starts.length) {
      delimiters.push(...starts.map((match) => match[1]))
      endCode()
      bodyLines = []
    }
  }

  // A body that was never closed is not one; its lines were shell all along.
  if (bodyLines) codeLines.push(...bodyLines)
  endCode()
  return segments
}

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

/** Highlight a run of shell, then colour the tokens the grammar left plain. */
function highlightShell(text: string): string {
  const template = document.createElement("template")
  template.innerHTML = hljs.highlight(text, { language: "bash", ignoreIllegals: true }).value

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

/** The grammars a tool summary can be read as. */
export type SummaryLanguage = "bash" | "javascript"

/**
 * Highlight a tool summary that is code — a shell command or a script — adding
 * the tokens the bash grammar leaves plain so the row reads as colourfully as a
 * code block, and leaving the body of a here-document uncoloured: it is prose
 * handed to a command, not the command itself.
 *
 * The result keeps the code's newlines; the row renders them, so a summary that
 * spans lines is not reflowed into one paragraph. Returns null when the code is
 * too long to bother with.
 */
export function highlightCodeSummary(code: string, language: SummaryLanguage): string | null {
  const lineCount = code.length ? code.split("\n").length : 0
  if (lineCount > MAX_LINES) return null

  try {
    if (language !== "bash") return hljs.highlight(code, { language, ignoreIllegals: true }).value
    return commandSegments(code)
      .map((segment) => (segment.code ? highlightShell(segment.text) : escapeHtml(segment.text)))
      .join("\n")
  } catch {
    return null
  }
}
