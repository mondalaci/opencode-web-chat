import { ref, watch } from "vue"

export interface Attachment {
  id: string
  mime: string
  /** Data URL (base64) sent as the file part `url`. */
  url: string
  filename: string
}

/**
 * The draft outlives the page it was typed into.
 *
 * Attaching from Google Photos sends the tab to Google Photos and the app comes
 * back on the next navigation, which is a fresh page with empty memory — so a
 * prompt typed before picking would be lost by the trip. The text is kept in the
 * tab's own storage, which is what the trip can survive; the attachments are not,
 * being data URLs that can be far too large to write there.
 */
const DRAFT_KEY = "opencode-draft"

function readDraft(): string {
  try {
    return sessionStorage.getItem(DRAFT_KEY) ?? ""
  } catch {
    return ""
  }
}

/** Shared composer draft so empty-state suggestions can prefill the input. */
export const draft = ref(readDraft())

watch(draft, (value) => {
  try {
    if (value) sessionStorage.setItem(DRAFT_KEY, value)
    else sessionStorage.removeItem(DRAFT_KEY)
  } catch {
    /* Storage being refused only costs the draft on the next navigation. */
  }
})

/** Files attached to the composer (picked, pasted or dropped), sent as file parts. */
export const attachments = ref<Attachment[]>([])

/** Bumped to ask the composer to focus its input (e.g. after a new chat). */
export const composerFocusRequest = ref(0)

export function requestComposerFocus() {
  composerFocusRequest.value += 1
}

let counter = 0
function nextId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  return `att-${Date.now()}-${counter++}`
}

function readAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

/** Attach a picked, pasted or dropped file of any type. */
export async function addFile(file: File): Promise<Attachment | null> {
  const mime = file.type || "application/octet-stream"
  const url = await readAsDataUrl(file)
  if (!url) return null
  const isImage = mime.startsWith("image/")
  const extension = (mime.split("/")[1] || "bin").replace("+xml", "")
  const fallback = isImage ? `pasted-image-${Date.now()}.${extension}` : `file-${Date.now()}.${extension}`
  const attachment: Attachment = {
    id: nextId(),
    mime,
    url,
    filename: file.name && file.name !== "image.png" ? file.name : fallback,
  }
  attachments.value = [...attachments.value, attachment]
  return attachment
}

export function removeAttachment(id: string) {
  attachments.value = attachments.value.filter((item) => item.id !== id)
}

export function clearAttachments() {
  attachments.value = []
}

export function useDraft() {
  return { draft, attachments }
}