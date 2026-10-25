import { computed, onScopeDispose, ref, watch } from "vue"
import iconUrl from "../../build/icon.png"
import { useChat } from "./chat"

/**
 * Drives the tab favicon.
 *
 * The tab carries the same traffic light as the sidebar, drawn the way the
 * desktop tray draws it: the app icon with a state dot in the corner. A dot
 * survives the browser's downscale to 16px where the animated spinner did not —
 * it is a solid shape on a dark icon, not a thin light ring on light artwork.
 *
 * The colours are the tray's rather than the sidebar's: the sidebar's muted
 * greys vanish against the icon at tab size, where the panel's brighter set
 * still reads.
 */

export type TabState = "blocked" | "working" | "done" | "idle"

const DOT_COLOURS: Record<TabState, string> = {
  blocked: "#e5484d",
  working: "#f5a623",
  done: "#35c06a",
  idle: "#c2c2c2",
}

/** Drawn at 64px; the browser scales it down to the tab slot. */
const SIZE = 64

/**
 * The dot's radius, as a fraction of the icon. The tray draws at 0.15, but a
 * tab slot is 16px: there the dot came out under 5px across, which is a smudge
 * rather than a signal, so it is drawn at 1.5× that here.
 */
const DOT_RADIUS = 0.225

/** The app icon, once the browser has decoded it. */
let icon: HTMLImageElement | null = null

function loadIcon(): Promise<HTMLImageElement> {
  if (icon) return Promise.resolve(icon)
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      icon = image
      resolve(image)
    }
    image.onerror = () => reject(new Error(`could not load ${iconUrl}`))
    image.src = iconUrl
  })
}

/** Icon plus corner dot, cached per state — the bitmap only changes on a state change. */
const rendered = new Map<TabState, string>()

async function renderIcon(state: TabState): Promise<string> {
  const cached = rendered.get(state)
  if (cached) return cached

  const image = await loadIcon().catch(() => null)
  if (!image) return iconUrl

  const canvas = document.createElement("canvas")
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext("2d")
  if (!ctx) return iconUrl

  ctx.drawImage(image, 0, 0, SIZE, SIZE)

  const offset = SIZE / 32
  const radius = SIZE * DOT_RADIUS
  const cx = SIZE - radius - offset / 2
  const cy = SIZE - radius - offset / 2

  // A dark ring under the dot keeps it clear of the icon's own light artwork.
  ctx.beginPath()
  ctx.arc(cx, cy, radius + offset, 0, Math.PI * 2)
  ctx.fillStyle = "rgba(0, 0, 0, 0.35)"
  ctx.fill()

  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.fillStyle = DOT_COLOURS[state]
  ctx.fill()

  const url = canvas.toDataURL("image/png")
  rendered.set(state, url)
  return url
}

function iconLink(): HTMLLinkElement | null {
  if (typeof document === "undefined") return null
  return document.querySelector<HTMLLinkElement>('link[rel~="icon"]')
}

/**
 * A turn that finished while the tab was in the background. It is the one state
 * that is cleared by looking at it, which is what `useFaviconProgress` does.
 */
const unread = ref(false)

let originalHref: string | null = null
/** Guards against an earlier, slower render landing after a newer state. */
let renderToken = 0

async function setFavicon(state: TabState) {
  const link = iconLink()
  if (!link) return

  if (originalHref == null) originalHref = link.getAttribute("href") ?? "/icon.png"

  const mine = ++renderToken
  // Idle leaves the plain logo: a permanently grey dot is noise, and the icon
  // is the app's mark whenever there is nothing to report.
  const href = state === "idle" ? originalHref : await renderIcon(state)
  if (mine !== renderToken) return
  link.href = href
}

export function useFaviconProgress() {
  const chat = useChat()

  const state = computed<TabState>(() => {
    if (chat.awaitingUser.value) return "blocked"
    if (chat.isBusy.value) return "working"
    if (unread.value) return "done"
    return "idle"
  })

  // A turn that ends while the user is elsewhere leaves a green dot behind;
  // looking at the tab is what acknowledges it.
  const looking = () => document.visibilityState === "visible" && document.hasFocus()
  let wasBusy = chat.isBusy.value

  watch(chat.isBusy, (busy) => {
    if (wasBusy && !busy && !looking()) unread.value = true
    wasBusy = busy
  })

  const acknowledge = () => {
    if (looking()) unread.value = false
  }
  document.addEventListener("visibilitychange", acknowledge)
  window.addEventListener("focus", acknowledge)

  watch(state, (value) => void setFavicon(value), { immediate: true })

  onScopeDispose(() => {
    document.removeEventListener("visibilitychange", acknowledge)
    window.removeEventListener("focus", acknowledge)
  })

  return { state }
}
