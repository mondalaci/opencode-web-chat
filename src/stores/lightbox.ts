import { ref } from "vue"

/**
 * Click-to-enlarge for images in a conversation.
 *
 * The image is shown in an overlay that fills the window, and clicking again
 * returns it to exactly the size it had in the thread — the inline rendering is
 * never resized, so there is nothing to restore.
 */

export interface LightboxImage {
  src: string
  alt: string
}

const image = ref<LightboxImage | null>(null)

/** The image being enlarged, if any. */
export const lightboxImage = image

export function openImage(src: string, alt = "") {
  if (src) image.value = { src, alt }
}

export function closeImage() {
  image.value = null
}
