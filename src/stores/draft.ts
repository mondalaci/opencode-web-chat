import { ref } from "vue"

export interface Attachment {
  id: string
  mime: string
  /** Data URL (base64) sent as the file part `url`. */
  url: string
  filename: string
}

/** Shared composer draft so empty-state suggestions can prefill the input. */
export const draft = ref("")

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