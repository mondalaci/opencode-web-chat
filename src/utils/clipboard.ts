/**
 * Put text on the clipboard, and say whether it got there.
 *
 * The async Clipboard API is the way, but it is only there on a secure origin —
 * `localhost` counts, a plain `http://` address on the LAN does not — and a
 * browser may still refuse it. A link that silently copied nothing would be
 * worse than one that did not try, so the older selection-based copy is the
 * fallback. Nothing here reports a failure to the reader: a permalink is also in
 * the address bar, which is the copy that always works.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* insecure origin, or a permission the browser would not grant */
  }
  try {
    const area = document.createElement("textarea")
    area.value = text
    area.setAttribute("readonly", "")
    // Off screen but still selectable: a hidden element cannot be selected, and
    // a visible one would make the thread jump as the copy is taken.
    area.style.position = "fixed"
    area.style.top = "-1000px"
    area.style.opacity = "0"
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand("copy")
    document.body.removeChild(area)
    return copied
  } catch {
    return false
  }
}
