import { ref } from "vue"

/**
 * Where a link points, as the thread reads it.
 *
 * A permalink names a message the conversation may not have loaded yet, and a
 * click on a timestamp asks for a message the thread may already be showing, so
 * the request is a pair: the message asked for, and a counter that changes on
 * every ask. The thread honours each counter once — that is what lets a second
 * click on the same stamp land again, and what keeps a pending landing from
 * being applied twice as the messages arrive.
 */
export const anchorTarget = ref<string | null>(null)
export const anchorRequest = ref(0)

/** The message a link just landed on, which flashes for a moment. */
export const anchorFlash = ref<string | null>(null)

/** Ask the thread to land on a message; `null` withdraws a request. */
export function requestAnchor(messageID: string | null) {
  anchorTarget.value = messageID
  anchorRequest.value++
}
