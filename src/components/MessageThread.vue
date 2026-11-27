<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue"
import { ChevronRight } from "lucide-vue-next"
import type { SessionMessageInfo } from "@/api/types"
import MessageItem from "./MessageItem.vue"
import Caret from "./Caret.vue"
import Spinner from "./Spinner.vue"
import ThreadPrompts from "./ThreadPrompts.vue"
import { useChat } from "@/stores/chat"
import { compactReading } from "@/stores/reading"
import { collapsedTurns, stepSummary } from "@/utils/compact"
import { anchorFlash, anchorRequest, anchorTarget } from "@/stores/anchor"

const { messages, conversation, loading, currentSessionID, scrollToBottomRequest, contentBelow, pendingForms, pendingPermissions, isBusy, awaitingUser, turnAnchor } = useChat()

const viewport = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const pinned = ref(true)

/** What the scrollbar's ticks mark: the prompts, in the order they were asked. */
const promptIDs = computed(() => conversation.value.filter((message) => message.type === "user").map((message) => message.id))

/**
 * Turns the reader has opened again in the compact view, by the prompt that
 * opened them. Expansion belongs to the view rather than to the conversation: a
 * turn opened to see what a call did folds away again with the next session.
 */
const opened = ref<Set<string>>(new Set())

const collapsed = computed(() => collapsedTurns(conversation.value, compactReading.value))

/** One row per message, with what the compact view makes of it. */
interface Row {
  message: SessionMessageInfo
  /** What the turn's summary line says, when this row is where it is drawn. */
  summary: string | null
  /** The prompt that opened the row's turn: what an opened turn is remembered by. */
  key: string
  /** Whether the row's steps are folded away. */
  compacted: boolean
}

const rows = computed<Row[]>(() =>
  conversation.value.map((message) => {
    const turn = collapsed.value.get(message.id) ?? null
    return {
      message,
      summary: turn && turn.anchor === message.id ? stepSummary(turn) : null,
      key: turn?.key ?? "",
      compacted: !!turn && !opened.value.has(turn.key),
    }
  }),
)

/** Fold a turn's steps away again, or open them. */
function toggleTurn(key: string) {
  const next = new Set(opened.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  opened.value = next
}

// Distance (px) from the bottom that still counts as "at the bottom".
const BOTTOM_EPSILON = 8

/**
 * Where our own follow last put the thread, so the scroll event it raises is not
 * mistaken for a decision to detach from the bottom.
 *
 * A flag that says "a follow is in flight" would not do: the follow runs on the
 * frame a growth lands, so a reader who scrolled up in that same frame would have
 * their move swallowed as the echo of our own write and be pulled back to the
 * bottom. The position can tell the two apart, and a stale value is harmless —
 * it is a position the thread would only be at by being at the bottom anyway.
 */
let followed: number | null = null
let touchY = 0

/**
 * The id of the trailing assistant message, used to decide which message may
 * still be receiving output.
 *
 * A missing `time.completed` alone does not mean "streaming": an interrupted or
 * migrated message keeps no completion time forever, which would leave a caret
 * blinking in a session that is idle. The live session status gates it.
 */
const lastAssistantID = computed(() => {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    if (messages.value[i].type === "assistant") return messages.value[i].id
  }
  return null
})

/**
 * Which side of the conversation the reader is looking at last, past the
 * bookkeeping messages woven between them — a skill, a shell command, a
 * compaction — which are drawn as notes and belong to neither.
 *
 * A prompt is in the conversation from the moment it is sent, while the reply it
 * asks for arrives with the first part of the model's own step. In the moment
 * between, the newest side is the prompt and the last assistant message is still
 * the *previous* turn's answer.
 */
const newest = computed<"user" | "assistant" | null>(() => {
  for (let i = conversation.value.length - 1; i >= 0; i--) {
    const type = conversation.value[i].type
    if (type === "assistant" || type === "user") return type
  }
  return null
})

/**
 * The reply the running turn is writing, if it has started one — the caret's only
 * home.
 *
 * The caret is the turn's heartbeat, so it blinks for as long as the turn runs —
 * while prose streams and while a tool call outlives the step that started it —
 * but only on a reply of *this* turn. The two are told apart by the mark the
 * store leaves where the turn began: a reply after the mark is this turn's,
 * while one at or before it belongs to a turn that has already ended, and a caret
 * left there blinks on the previous answer. That is what a rule reading only "the
 * newest assistant message" did — for a prompt just sent, whose own reply does
 * not exist yet, and for a slash command, which starts a turn without adding a
 * message at all.
 *
 * A turn this view did not start — a session opened while it is already running —
 * carries no mark, and falls back to the unfinished message: a reply that was
 * never completed is one still being written.
 *
 * A turn parked on a question or a permission is waiting for the reader, not the
 * model, so no reply of its own carries the caret yet: a cursor above the card
 * would promise something nothing is keeping.
 */
const turnReply = computed(() => {
  if (!isBusy.value || awaitingUser.value) return null
  const list = conversation.value
  let at = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].type === "assistant") {
      at = i
      break
    }
  }
  const reply = at < 0 ? null : list[at]
  if (!reply || reply.type !== "assistant") return null
  const anchor = list.findIndex((message) => message.id === turnAnchor.value)
  if (anchor >= 0) return at > anchor ? reply : null
  return reply.time?.completed ? null : reply
})

/**
 * A running turn that has not begun to answer: the caret waits under the prompt,
 * in the column the reply's text will fill, instead of blinking on the reply that
 * came before it.
 *
 * Only when the turn has no reply of its own, though. A prompt sent while a turn
 * is still writing lands *after* the reply it is adding to, and so does a
 * question's typed answer, which the conversation weaves in where the tool asked.
 * The newest side then reads as the reader's while the reply above it keeps its
 * caret, and waiting here would put a second one below it — two hearts for one
 * turn, the lower one promising a reply that is already being written above.
 */
const waiting = computed(
  () => isBusy.value && !awaitingUser.value && !turnReply.value && newest.value === "user",
)

/** Whether the thread is showing the end of the conversation. */
function atEnd(el = viewport.value) {
  return !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_EPSILON
}

function onScroll() {
  const el = viewport.value
  if (!el) return
  if (followed !== null) {
    const ours = followed
    followed = null
    // Our own follow coming back. Anything else is the reader's move, and it is
    // judged below.
    if (Math.abs(el.scrollTop - ours) <= BOTTOM_EPSILON) return
  }
  // While the thread is loading, the spinner stands in for the conversation and
  // the area is shorter than it was: the offset is clamped, and the viewport then
  // reports itself at the bottom from anywhere. That is the reload talking, not
  // the reader returning, and re-pinning on it would drag a long conversation to
  // its end as soon as the messages came back.
  if (loading.value) return
  // Any scroll of the reader's own that leaves the bottom detaches immediately,
  // so even a small scroll-up during streaming sticks instead of being pulled
  // back. Re-attach only when the reader returns to (near) the bottom.
  pinned.value = atEnd(el)
}

function detach() {
  pinned.value = false
}

/**
 * Whether this scroll will be taken by a part of a message that scrolls on its
 * own — a reasoning block, a shell's output, a long notice — rather than by the
 * thread.
 *
 * Such a part takes the wheel first and the thread stays exactly where it is,
 * so a scroll over it says nothing about the reader leaving the end of the
 * conversation. Reading back through a shell's output is not leaving it, and
 * treating it as if it were stopped the follow while the thread was still at
 * the end — where no scroll of its own can ever start it again, because there
 * is nothing left to scroll. The conversation then sat still while the reply
 * went on below the fold, and scrolling down did not bring it back: the thread
 * was already at its end, so the wheel had nothing to move.
 *
 * `deltaY` is negative for a scroll toward the start, which is the only
 * direction that can leave the end.
 */
function takenByPart(path: EventTarget[], deltaY: number): boolean {
  for (const node of path) {
    if (node === viewport.value) return false
    if (!(node instanceof HTMLElement)) continue
    const overflow = getComputedStyle(node).overflowY
    if (overflow !== "auto" && overflow !== "scroll") continue
    // Where the part has somewhere to go, the browser gives it the scroll and
    // never passes it on to the thread.
    if (deltaY < 0 ? node.scrollTop > 0.5 : node.scrollHeight - node.clientHeight - node.scrollTop > 0.5) {
      return true
    }
  }
  return false
}

function onWheel(event: WheelEvent) {
  const el = viewport.value
  if (!el) return
  if (event.deltaY < 0) {
    if (!takenByPart(event.composedPath(), event.deltaY)) detach()
    return
  }
  // Down with nowhere further down to go: the thread is already at the end, so
  // no scroll of its own will ever come to say so. Take the wheel itself as the
  // reader asking for the end, and follow again.
  if (event.deltaY > 0 && atEnd(el)) pinned.value = true
}

function onTouchStart(event: TouchEvent) {
  touchY = event.touches[0]?.clientY ?? 0
}

function onTouchMove(event: TouchEvent) {
  // A finger moving down scrolls toward the start, and says as little about
  // leaving the end as a wheel does when a part of a message takes it.
  if ((event.touches[0]?.clientY ?? 0) > touchY + 4 && !takenByPart(event.composedPath(), -1)) detach()
}

/** Put the end of the conversation at the bottom edge, if the reader is there. */
function pinToBottom() {
  const el = viewport.value
  // A link that is still on its way to a message outranks the follow: the reader
  // asked to be somewhere other than the end.
  if (!el || !pinned.value || anchorPending()) return
  el.scrollTop = el.scrollHeight
  followed = el.scrollTop
}

/** The same, once the update that asked for it has reached the DOM. */
async function scrollToBottom() {
  await nextTick()
  pinToBottom()
}

/* ------------------------------- message links ------------------------------- */

/** How long a message stays marked after a link lands on it. */
const FLASH_MS = 1600

/** The request the thread has already honoured, so none is honoured twice. */
let anchorDone = -1
let flashTimer: ReturnType<typeof setTimeout> | null = null

/** Whether a link is waiting to be honoured. */
function anchorPending(): boolean {
  return anchorTarget.value !== null && anchorRequest.value !== anchorDone
}

/** The drawn row of a message, if the thread is showing it. */
function messageRow(id: string): HTMLElement | null {
  return content.value?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`) ?? null
}

/**
 * Put a row in the middle of the thread.
 *
 * The placement is measured against the heights the browser has for the rows
 * around it, and a long conversation only knows the height of what it has laid
 * out: a row it has not been near is taken at `contain-intrinsic-size`'s
 * estimate. So the landing is corrected over a few frames, by which time the
 * rows the jump brought into view have been laid out and the message sits where
 * it was asked to. A row taller than the thread is aligned to its top instead,
 * so the link lands on the beginning of what it points at rather than on the
 * middle of it.
 */
function landOn(row: HTMLElement) {
  let frames = 0
  const step = () => {
    const host = viewport.value
    if (!host) return
    const box = host.getBoundingClientRect()
    const rect = row.getBoundingClientRect()
    const offset = Math.max(12, (host.clientHeight - rect.height) / 2)
    const delta = rect.top - box.top - offset
    if (Math.abs(delta) > 1) host.scrollTop += delta
    if (++frames < 4) requestAnimationFrame(step)
  }
  step()
}

/**
 * Whether a row is already wholly inside the thread. A link to something the
 * reader is looking at is a copy, not a jump: moving the conversation under
 * their eyes to show them a message they can already see helps nobody.
 */
function inView(row: HTMLElement): boolean {
  const host = viewport.value
  if (!host) return false
  const box = host.getBoundingClientRect()
  const rect = row.getBoundingClientRect()
  return rect.top >= box.top && rect.bottom <= box.bottom
}

/**
 * Land on the message a link names.
 *
 * Runs when a link is followed and again as the conversation arrives, because a
 * permalink is read before the chat it names has loaded. A message the
 * conversation does not have — deleted since the link was made, or named by a
 * URL that was typed by hand — leaves the thread where an ordinary open puts it.
 */
async function applyAnchor() {
  if (!anchorPending() || loading.value) return
  await nextTick()
  const id = anchorTarget.value
  if (!id) return
  anchorDone = anchorRequest.value
  const row = messageRow(id)
  if (!row) {
    pinToBottom()
    return
  }
  // Moving the view means the thread stops following the end of the conversation
  // until the reader goes back to it themselves; a message already on screen is
  // left where it is, and the follow is left alone.
  if (!inView(row)) {
    pinned.value = false
    landOn(row)
  }
  anchorFlash.value = id
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => (anchorFlash.value = null), FLASH_MS)
}

// The conversation arriving is what makes a message findable, so the landing is
// retried as messages are loaded — not only when a link is followed. It is also
// applied on mount: a permalink is read while the app is still connecting, which
// is before this thread exists to hear about it, and the request it left behind
// is the one the first render has to honour.
watch([anchorRequest, loading, () => messages.value.length], () => void applyAnchor(), {
  flush: "post",
  immediate: true,
})

onBeforeUnmount(() => {
  if (flashTimer) clearTimeout(flashTimer)
})

/**
 * Follow the conversation as the thread grows.
 *
 * Watching the message list is not enough. Content reaches the store in two
 * ways: the array is replaced — a new message, a reconciled tail — or a message
 * is changed in place, which is what every streamed delta does, a token and a
 * tool call's arguments alike. A watcher on the ref sees only the first; the
 * second is the common one while a turn runs, because rebuilding the array on
 * every delta is exactly what the store avoids. A tool card whose command was
 * still streaming therefore grew below the fold and stayed there until the next
 * reconcile happened to replace the array — which is the "catching up" a reader
 * sees.
 *
 * What the follow needs to know is not what changed but that the thread got
 * taller, and the height is also the only thing that sees the growth the store
 * never learns of at all: an attached picture, a rendered diagram, a code block
 * settling into its final layout a frame after it was inserted. So the content's
 * own box is what is watched, and every change to it re-pins the reader who is
 * at the bottom; `pinToBottom` is a no-op for one who has gone up the
 * conversation.
 *
 * This is also what makes watching the list unnecessary: a replacement the
 * observer would not see is one that left the thread the same height, and a
 * thread that did not change height did not move its own end.
 *
 * The observer runs with the layout that grew the thread, so the follow is
 * applied in the same frame as the growth rather than a frame late.
 */
let follower: ResizeObserver | null = null

watch(
  content,
  (element) => {
    follower?.disconnect()
    follower = null
    if (!element) return
    follower = new ResizeObserver(pinToBottom)
    follower.observe(element)
  },
  // The ref holds an element only once the loading spinner is gone.
  { flush: "post" },
)

onBeforeUnmount(() => {
  follower?.disconnect()
  follower = null
})

watch(loading, (value) => {
  if (!value) void scrollToBottom()
})

watch(scrollToBottomRequest, () => {
  pinned.value = true
  void scrollToBottom()
})

/**
 * Publish the one thing the chrome outside the thread cannot see: whether the
 * conversation continues below the fold. The button that answers it hangs at the
 * bottom of the window, in the composer's row, and only this element's scroll
 * geometry knows the answer.
 */
watch(pinned, (value) => { contentBelow.value = !value }, { immediate: true })

watch(currentSessionID, () => {
  pinned.value = true
  followed = null
  opened.value = new Set()
}, { flush: "post" })

/**
 * A question or a permission card is appended to the conversation, which grows
 * the thread without touching `messages`. Follow it the way a new message is
 * followed, so an ask that arrives while the view is pinned does not end up
 * below the fold. `scrollToBottom` is a no-op while the reader has scrolled up.
 */
watch(
  [() => pendingForms.value.length, () => pendingPermissions.value.length],
  ([forms, permissions], [wasForms, wasPermissions]) => {
    if (forms > wasForms || permissions > wasPermissions) void scrollToBottom()
  },
)
</script>

<template>
  <div class="thread-host">
    <div
      ref="viewport"
      class="thread"
      @scroll="onScroll"
      @wheel="onWheel"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="onTouchMove"
    >
      <div v-if="loading" class="loading"><Spinner :size="18" /></div>

      <template v-else>
        <!-- One element for the whole conversation, so that a reply growing
             while the reader is somewhere else still moves what hangs off the
             scrollbar: the marks are placed by the height of this, and a message
             arriving above them is not the only thing that changes it. -->
        <div ref="content" class="content">
          <template v-for="row in rows" :key="row.message.id">
            <!-- The steps the compact view folded away, in one line where the
                 first of them would have been. A click brings the turn back
                 whole, in its own order, and folds it away again. -->
            <div v-if="row.summary" class="steps">
              <button
                type="button"
                class="steps-toggle"
                :aria-expanded="!row.compacted"
                :title="`${row.compacted ? 'Show' : 'Hide'} ${row.summary}`"
                @click="toggleTurn(row.key)"
              >
                <ChevronRight :size="13" class="steps-chevron" :class="{ open: !row.compacted }" />
                <span>{{ row.summary }}</span>
              </button>
            </div>

            <MessageItem
              :message="row.message"
              :streaming="isBusy && row.message.id === lastAssistantID && row.message.type === 'assistant' && !row.message.time.completed"
              :caret="row.message.id === turnReply?.id"
              :latest="row.message.id === lastAssistantID"
              :compact="row.compacted"
            />
          </template>

          <!-- The caret of a turn that has not begun to answer: it hangs below the
               prompt, where the reply it is waiting for will be drawn. -->
          <div v-if="waiting" class="caret-row"><Caret /></div>

          <!-- Turn-level widgets the app weaves into the conversation: questions
               and permission cards sit after the last message, in the flow of the
               thread. -->
          <slot />

          <div class="spacer"></div>
        </div>
      </template>
    </div>

    <ThreadPrompts :body="viewport" :content="content" :ids="promptIDs" />
  </div>
</template>

<style scoped>
/* A frame around the scrolling thread for the ticks to be positioned in: they
   belong on the scrollbar, which is a child's furniture and not the thread's. */
.thread-host {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
}
.thread {
  flex: 1;
  overflow-y: auto;
  /* A conversation never scrolls sideways. Parts that are genuinely wider than
     the column — a code block or a diagram — carry their own scrollbar, and a
     table wraps to fit instead, so anything left over is a line that failed to
     wrap: it should be clipped rather than drag the whole conversation out of
     view. */
  overflow-x: hidden;
  padding: 20px 20px 0;
  /* Message metadata hangs in the gutter outside the content column, and how
     much gutter there is depends on this element's width — not the window's,
     which the sidebar also eats into. So the thread is a query container, and
     `MessageItem` asks it whether there is room. */
  container: thread / inline-size;
  /* No `scroll-behavior: smooth`: the animation fires intermediate scroll
     events that re-pin the view to the bottom mid-follow, fighting a user who
     is scrolling up. Programmatic follows are instant instead. */
  /* Reserve a symmetric gutter so a scrollbar does not shift the centered
     content column off the composer's center. */
  scrollbar-gutter: stable both-edges;
  /* The bar is still here — it keeps its width, and dragging it still scrolls —
     but it is not painted: the theme pads a scrollbar's painted thumb inside the
     track, and that padding is several times the height of the marks hanging off
     this thread, so the browser's thumb and the marks could never line up.
     `ThreadPrompts` draws the thumb instead, from the same arithmetic the marks
     use. */
  scrollbar-color: transparent transparent;
}
.loading {
  display: grid;
  place-items: center;
  height: 100%;
  color: var(--text-muted);
}
/* The caret of a turn whose reply has not started. It stands in the column the
   reply's text will fill — past the avatar gutter every reply leaves — so it
   blinks where the answer is about to appear, under the prompt that asked for
   it. The row is the height a message's own row is, so the prompt and the cursor
   keep the spacing they would have had. */
.caret-row {
  max-width: var(--content-width);
  margin: 0 auto;
  width: 100%;
  padding: 10px 0 10px calc(28px + 12px);
}
/* The line that stands where a turn's steps were folded away: a disclosure in
   the muted mono the notes use, in the same column the reply's text fills, so it
   reads as the conversation's own furniture rather than as a message. */
.steps {
  max-width: var(--content-width);
  margin: 0 auto;
  width: 100%;
  padding: 1px 0;
  /* Past the avatar gutter the reply leaves, the way a note row is. */
  padding-left: calc(28px + 12px);
}
.steps-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 6px 2px 4px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.5;
  cursor: pointer;
}
.steps-toggle:hover {
  background: var(--bg-hover);
  color: var(--text-muted);
}
.steps-chevron {
  flex: none;
  transition: transform 0.15s ease;
}
.steps-chevron.open {
  transform: rotate(90deg);
}
.spacer {
  height: 12px;
}
</style>