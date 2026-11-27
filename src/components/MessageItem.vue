<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue"
import { ChevronRight, Info, Sparkles, Terminal, User } from "lucide-vue-next"
import type {
  AssistantContent,
  AssistantTool,
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionMessageShell,
} from "@/api/types"
import { formatCost, formatDateTime, formatTokens } from "@/utils/format"
import { endedAtOutputLimit } from "@/utils/truncation"
import { drawnBlocks, readableBlock } from "@/utils/blocks"
import { attachmentView } from "@/utils/file"
import { composedMessage } from "@/utils/compose"
import { copyText } from "@/utils/clipboard"
import { linkify } from "@/utils/linkify"
import { isStop } from "@/utils/stop"
import { messagePermalink } from "@/utils/url"
import { anchorFlash } from "@/stores/anchor"
import { shortcutsVisible } from "@/stores/shortcuts"
import { useServer } from "@/stores/server"
import { useApp } from "@/stores/app"
import { useChat } from "@/stores/chat"
import Caret from "./Caret.vue"
import Markdown from "./Markdown.vue"
import PartFile from "./PartFile.vue"
import PartMessageCompose from "./PartMessageCompose.vue"
import PartReasoning from "./PartReasoning.vue"
import PartTool from "./PartTool.vue"

const props = defineProps<{
  message: SessionMessageInfo
  streaming?: boolean
  caret?: boolean
  /** The newest assistant message, the only one a "Continue" makes sense on. */
  latest?: boolean
  /**
   * This message belongs to a turn whose steps the compact view collapsed: only
   * what is readable is drawn, and a message left with nothing to show does not
   * draw at all.
   */
  compact?: boolean
}>()

/** The model list, for naming the model a message ran on. */
const { models } = useServer()
const app = useApp()
const { messages, currentSessionID } = useChat()

const kind = computed(() => props.message.type)
const isUser = computed(() => kind.value === "user")
const isAssistant = computed(() => kind.value === "assistant")

/**
 * The reason a turn ended in failure, as the server recorded it on the idle
 * message. A reply's own error block covers a step that failed mid-answer; this
 * is the whole turn ending with nothing to show — a provider that refused the
 * request, for instance.
 *
 * A step that failed already printed its reason on the reply it interrupted, and
 * the idle message repeats the same failure. The row is only shown when the turn
 * has no reply carrying the error, so the reason is never printed twice.
 */
const turnFailure = computed(() => {
  const message = props.message
  if (message.type !== "idle" || message.outcome !== "failed") return null
  const text = message.error?.message || "The turn failed."
  const list = messages.value
  const index = list.findIndex((item) => item.id === message.id)
  for (let i = index - 1; i >= 0; i--) {
    const item = list[i]
    if (item.type === "user") break
    if (item.type === "assistant" && item.error) {
      // The reply's own error block already says why this turn failed.
      if ((item.error.message || "The model returned an error.") === text) return null
      break
    }
  }
  return text
})

/**
 * Message types that only record state (the agent/model switched away, the
 * session went idle) carry nothing to display, so they are skipped entirely
 * instead of leaving an empty row behind. A failed idle is the exception: it is
 * the server's own record of a turn that ended with no reply, and the only place
 * the reason survives a reload.
 */

const assistant = computed(() => (isAssistant.value ? (props.message as SessionMessageAssistant) : null))

/**
 * Assistant output blocks, as the thread draws them.
 *
 * The compact view keeps what is readable and drops the steps that produced it;
 * the summary line above the turn brings them back.
 */
const content = computed<AssistantContent[]>(() => {
  const message = assistant.value
  if (!message) return []
  const blocks = drawnBlocks(message)
  return props.compact ? blocks.filter(readableBlock) : blocks
})

/**
 * What the reader wrote, as HTML.
 *
 * A prompt is quoted rather than interpreted: it is drawn verbatim, not rendered
 * as markdown, so the words stay the reader's own. The one thing done to it is
 * the one thing a reader expects of a URL in it — a link. `linkify` escapes
 * everything it is handed, so the text is still theirs and cannot become markup.
 */
const userHtml = computed(() => (props.message.type === "user" && props.message.text ? linkify(props.message.text) : ""))
const userFiles = computed(() =>
  props.message.type === "user" ? (props.message.files ?? []).map(attachmentView) : [],
)

const shell = computed<SessionMessageShell | null>(() =>
  props.message.type === "shell" ? (props.message as SessionMessageShell) : null,
)

/**
 * Server notices and skill activations are authored by neither side of the
 * conversation. They keep the assistant's avatar slot so their text starts at
 * the same left edge as assistant prose, and the card fills the rest of the row.
 *
 * A notice is usually a line. The harness also delivers whole documents this way
 * — an instruction update such as the Code Mode tool catalog arrives as a
 * `system` message of several kilobytes — so a long one folds behind a labelled
 * header rather than filling the conversation with raw markdown.
 */
const notice = computed(() => {
  switch (props.message.type) {
    case "system":
    case "synthetic": {
      const text = props.message.text ?? ""
      return {
        text,
        icon: Info,
        label: props.message.description || "System notice",
        preview: text.split("\n")[0]?.trim() ?? "",
        foldable: text.length > 140 || text.includes("\n"),
      }
    }
    case "skill":
      return {
        text: `Activated skill ${props.message.name}`,
        icon: Sparkles,
        label: "",
        preview: "",
        foldable: false,
      }
    default:
      return null
  }
})

/** A folded notice stays closed until it is asked for. */
const noticeOpen = ref(false)

const compaction = computed(() => {
  if (props.message.type !== "compaction") return null
  const status = props.message.status
  const summary = "summary" in props.message ? props.message.summary : ""
  const failure = "error" in props.message ? props.message.error?.message : ""
  return { status, summary, failure }
})

const errorMessage = computed(() => {
  const message = assistant.value
  if (!message?.error) return null
  return message.error.message || "The model returned an error."
})

/**
 * A step that was stopped rather than failed. Interrupting a turn — the stop
 * button, or dismissing the question that was holding it — records an `aborted`
 * step error, which the alarm tone would read as a crash.
 */
const stoppedStep = computed(() => isStop(assistant.value?.error))

/** A turn waiting to try again after a failed step. */
const retryNote = computed(() => {
  const retry = assistant.value?.retry
  return retry ? `Retrying (attempt ${retry.attempt})…` : null
})

/**
 * Whether this is the newest assistant message and its step ended on an output
 * limit, so what the reader sees is the model being cut off rather than the
 * model stopping. A fresh turn is the only way to get the rest of the text, so
 * the bar is shown only where that makes sense: the last reply, settled, with no
 * error of its own and no turn already running.
 */
const truncated = computed(() => {
  const message = assistant.value
  if (!message || !props.latest || props.streaming || errorMessage.value) return false
  if (app.chat.isBusy.value || app.chat.awaitingUser.value) return false
  return endedAtOutputLimit(message.finish)
})

/**
 * Whether this message draws anything at all.
 *
 * State-only records are skipped, as above. So is a reply whose steps the
 * compact view collapsed and which has nothing of its own to show: the summary
 * line above the turn already stands where it was. What else it carries is a
 * reason to draw it — an error, a retry, a cut-off notice — and so is the caret,
 * the turn's heartbeat, which has no other home in the thread.
 */
const renders = computed(() => {
  const message = props.message
  if (message.type === "idle") return turnFailure.value !== null
  if (["agent-switched", "model-switched", "location-switched"].includes(message.type)) return false
  if (message.type !== "assistant" || !props.compact) return true
  if (errorMessage.value || retryNote.value || truncated.value || props.caret) return true
  return content.value.length > 0
})

/** Ask the model to carry on; the composer's own send path, on the same model. */
async function continueReply(): Promise<void> {
  const message = assistant.value
  if (!message) return
  await app.continueReply(message)
}

/**
 * The model a message ran on, as the picker named it, with the effort beside it.
 *
 * A message records only the model's id, which reads as a slug rather than as the
 * name the picker showed. This is plain text — `model: effort` — to sit with the
 * token and cost lines; the id stays available in the tooltip, and as the fallback
 * for a model the server no longer offers. "default" is the model's own neutral
 * effort, so it is left out.
 */
const modelLabel = computed(() => {
  const ref_ = assistant.value?.model
  if (!ref_) return null
  const info = models.value.find((item) => item.providerID === ref_.providerID && item.id === ref_.id)
  const name = info?.name || ref_.id
  const effort = ref_.variant && ref_.variant !== "default" ? ref_.variant : null
  return { text: effort ? `${name}: ${effort}` : name, reference: ref_.id }
})

/**
 * What holding `Alt` reveals over a message.
 *
 * The two sides are not symmetric: a model, a token count and a cost belong to
 * the step that answered a prompt, so an assistant message is the only one that
 * records them, while a prompt has the date it was sent. Each block says what
 * its own message carries rather than repeating the reply's figures.
 */
const meta = computed(() => {
  const message = props.message
  if (message.type === "user") {
    return { created: message.time?.created, model: "", reference: "", tokens: 0, cost: 0 }
  }
  const assistantMessage = assistant.value
  if (!assistantMessage) return null
  const tokens = assistantMessage.tokens
  const total = tokens ? (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) : 0
  return {
    model: modelLabel.value?.text ?? "",
    reference: modelLabel.value?.reference ?? "",
    tokens: total,
    cost: assistantMessage.cost ?? 0,
    created: assistantMessage.time?.created,
  }
})

/**
 * Whether holding `Alt` would add anything to a message's block: the model, the
 * tokens and the cost, which only a reply records. A prompt's block is the date
 * alone, and an empty one should not draw the card the figures hang in.
 */
const metaRest = computed(() => Boolean(meta.value?.model || meta.value?.tokens || meta.value?.cost))

/**
 * The message's own link: the chat it lives in and the message in it.
 *
 * A timestamp is the one thing every message has, so it is what a link hangs
 * from. The id is the server's own and never changes, which is what makes the
 * URL open the same message after a reload, a restart, or on someone else's
 * machine. A prompt the server has not yet given an id to is the exception: its
 * `local-` id is this tab's own and would not resolve anywhere.
 */
const permalink = computed(() => {
  const sessionID = currentSessionID.value
  if (!sessionID || props.message.id.startsWith("local-")) return ""
  return messagePermalink(sessionID, props.message.id)
})

/** The timestamp in the machine-readable form a `<time>` element carries. */
const stampISO = computed(() => {
  const created = meta.value?.created
  return created ? new Date(created).toISOString() : undefined
})

/** Confirmed for a moment in the stamp itself, so the copy is not silent. */
const linked = ref(false)
let linkedTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Follow this message's own link.
 *
 * The click is taken over so the copy and the landing happen in the open
 * conversation rather than as a page load, but the anchor keeps its `href`: a
 * modified click, a middle click and the browser's own "copy link address" all
 * still see a real URL.
 */
async function openPermalink(event: MouseEvent) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  app.linkToMessage(props.message.id)
  if (!(await copyText(permalink.value))) return
  linked.value = true
  if (linkedTimer) clearTimeout(linkedTimer)
  linkedTimer = setTimeout(() => (linked.value = false), 1600)
}

/** Whether this is the message a link just landed on, which flashes. */
const flashing = computed(() => anchorFlash.value === props.message.id)

onBeforeUnmount(() => {
  if (linkedTimer) clearTimeout(linkedTimer)
})

function isCompose(part: AssistantContent): boolean {
  return part.type === "tool" && composedMessage(part as AssistantTool) !== null
}

const shellExit = computed(() => {
  const value = shell.value?.exit
  if (value === undefined) return ""
  return typeof value === "number" ? `exit ${value}` : String(value)
})
</script>

<template>
  <div v-if="renders" class="message" :class="[isUser ? 'user' : isAssistant ? 'assistant' : 'note-row', { 'anchor-flash': flashing }]" :data-message-id="message.id">
    <div v-if="isAssistant || notice" class="avatar" aria-hidden="true">
      <!-- A robot, drawn here rather than imported: a rounded head with a stub
           antenna and side ears, and two eyes knocked out of the fill so they
           take the tile's own colour. -->
      <svg class="robot" viewBox="0 0 24 24">
        <g class="robot-body">
          <rect x="5" y="6" width="14" height="14" rx="3.5" />
          <rect x="11.1" y="4" width="1.8" height="2.8" rx="0.9" />
          <rect x="2.2" y="11" width="3" height="6" rx="1.3" />
          <rect x="18.8" y="11" width="3" height="6" rx="1.3" />
        </g>
        <g class="robot-eyes">
          <circle cx="9.4" cy="13" r="1.9" />
          <circle cx="14.6" cy="13" r="1.9" />
        </g>
      </svg>
    </div>

    <div v-if="isUser || isAssistant" class="body">
      <!-- The date is always here, hung beside the avatar; what the message cost
           arrives with the modifier, so nothing is spent on the figures until
           they are asked for. -->
      <div v-if="meta" class="meta" :title="meta.reference || undefined">
        <div class="meta-inner">
          <div v-if="meta.created" class="meta-row meta-datetime">
            <a
              v-if="permalink"
              class="stamp"
              :class="{ confirmed: linked }"
              :href="permalink"
              :title="linked ? 'Link copied' : 'Copy a link to this message'"
              @click="openPermalink"
            ><time :datetime="stampISO">{{ linked ? "Link copied" : formatDateTime(meta.created) }}</time></a>
            <time v-else :datetime="stampISO">{{ formatDateTime(meta.created) }}</time>
          </div>
          <div v-if="metaRest && !streaming && shortcutsVisible" class="meta-rest">
            <div v-if="meta.model" class="meta-model">{{ meta.model }}</div>
            <div v-if="meta.tokens" class="meta-row">{{ formatTokens(meta.tokens) }} tokens</div>
            <div v-if="meta.cost" class="meta-row">{{ formatCost(meta.cost) }}</div>
          </div>
        </div>
      </div>

      <div
        v-if="isUser"
        class="bubble user-bubble"
      >
        <p v-if="userHtml" class="user-text" v-html="userHtml"></p>
        <PartFile v-for="(file, index) in userFiles" :key="index" :file="file" />
      </div>

      <div v-else class="bubble assistant-bubble">
        <template v-for="(block, index) in content" :key="index">
          <Markdown v-if="block.type === 'text'" :text="block.text" :streaming="streaming" />
          <PartReasoning v-else-if="block.type === 'reasoning'" :part="block" />
          <template v-else-if="block.type === 'tool'">
            <PartMessageCompose v-if="isCompose(block)" :part="block" />
            <PartTool v-else :part="block" />
          </template>
        </template>

        <!-- The caret tracks the *turn*, not this message's text: a step ends when
             its generation does, while its tools are still running, so keying it
             off `time.completed` left the whole tool phase with no sign of
             progress at all. The parent withholds it while the turn waits on the
             reader. -->
        <Caret v-if="caret" />
        <div v-if="errorMessage" class="error" :class="{ stopped: stoppedStep }">{{ errorMessage }}</div>
        <div v-if="retryNote" class="retry">{{ retryNote }}</div>
        <div v-if="truncated" class="truncated">
          <span>This reply stopped at the model's output limit.</span>
          <button type="button" class="truncated-continue" @click="continueReply">Continue</button>
        </div>
      </div>
    </div>

    <div v-else-if="shell" class="shell-row">
      <Terminal :size="13" class="shell-icon" />
      <code class="shell-command">{{ shell.command }}</code>
      <span class="shell-status">{{ shell.status }}{{ shellExit ? ` · ${shellExit}` : "" }}</span>
      <pre v-if="shell.output?.output" class="shell-output">{{ shell.output.output }}</pre>
    </div>

    <div v-else-if="compaction" class="compaction">
      <span class="compaction-label">
        {{ compaction.status === "running" ? "Compacting conversation…" : "Conversation compacted" }}
      </span>
      <span v-if="compaction.failure" class="compaction-error">{{ compaction.failure }}</span>
    </div>

    <div v-else-if="turnFailure" class="turn-failure" role="alert">
      <span class="turn-failure-label">The turn failed</span>
      <span class="turn-failure-text">{{ turnFailure }}</span>
    </div>

    <div v-else-if="notice" class="notice" :class="{ folded: notice.foldable }">
      <button
        v-if="notice.foldable"
        class="notice-head"
        :aria-expanded="noticeOpen"
        @click="noticeOpen = !noticeOpen"
      >
        <component :is="notice.icon" :size="14" class="notice-icon" aria-hidden="true" />
        <span class="notice-label">{{ notice.label }}</span>
        <span class="notice-preview">{{ notice.preview }}</span>
        <ChevronRight :size="14" class="notice-chevron" :class="{ open: noticeOpen }" />
      </button>
      <div v-else class="notice-line">
        <component :is="notice.icon" :size="14" class="notice-icon" aria-hidden="true" />
        <p class="notice-text">{{ notice.text }}</p>
      </div>
      <!-- Shown as it arrived: this is the text the model was handed, down to its
           markdown furniture. -->
      <div v-if="notice.foldable && noticeOpen" class="notice-body">{{ notice.text }}</div>
    </div>

    <div v-if="isUser" class="avatar" aria-hidden="true"><User :size="15" /></div>
  </div>
</template>

<style scoped>
.message {
  position: relative;
  display: flex;
  gap: 12px;
  /* The padding the row is drawn with, named because the metadata block hangs
     outside it and has to add it back to land on the avatar's line. */
  --message-pad: 10px;
  padding: var(--message-pad) 0;
  max-width: var(--content-width);
  margin: 0 auto;
  width: 100%;
  /* The gutter an avatar needs: its own width plus the flex gap. Both rows
     reserve one, so the avatars hang outside the same content width. */
  --avatar-gutter: calc(28px + 12px);
  /* How far the avatar sits below the message's top edge. A block that opens an
     assistant message takes the same offset, so its top border lines up with the
     avatar instead of hanging below it. */
  --avatar-top: 2px;
}
.message.user {
  justify-content: flex-end;
}
.message.assistant {
  justify-content: flex-start;
}
.avatar {
  /* Both sides of the conversation wear the same tile; only the glyph differs. */
  --avatar-tile: var(--bg-active);
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: var(--avatar-tile);
  color: var(--text-muted);
  margin-top: var(--avatar-top);
}
.robot {
  display: block;
  width: 18px;
  height: 18px;
}
.robot-body {
  fill: currentColor;
}
/* The eyes are the tile showing through, hence the tile's own colour. */
.robot-eyes {
  fill: var(--avatar-tile);
}
/* The message's own column: the metadata line, then the bubble. In a window wide
   enough to hang the metadata in the gutter it is out of flow there, so the
   column is just the bubble and its width is the width it always had. */
.body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.message.assistant .body {
  flex: 1;
  /* Stop one gutter short of the column edge, where the user's bubble stops, so
     the assistant's content and the user's share one width and both avatars
     protrude past it. */
  margin-right: var(--avatar-gutter);
}
.message.user .body {
  flex: 1;
  /* Hug the avatar: the bubble is as wide as its text allows, and the metadata
     line above it follows the same edge. `80%` is the cap the bubble itself
     carried, moved here so the line is measured by the same width. */
  align-items: flex-end;
  max-width: 80%;
}
.bubble {
  min-width: 0;
  max-width: 100%;
  /* The browser's own windowing, and the reason a long conversation opens at
     once: a message's contents are laid out and painted only while the message
     is near the viewport, so a thread of thousands no longer lays all of them
     out to show the last screenful. The rows themselves stay in the document —
     they are what the scrollbar's marks, the find bar and the scroll position
     are read from — and only their interiors are skipped.
     
     On the bubble rather than on the whole row: `content-visibility` implies
     paint containment, and a message's own metadata hangs *outside* the row's
     box, in the gutter, where it would be clipped away.
     
     `contain-intrinsic-size` is the size a message is taken to have until it has
     been laid out once, after which the browser remembers the real one (`auto`).
     It is the average of a long conversation's rows, measured on the thread this
     was written for; it only decides how far the scrollbar and its marks are out
     before the reader has been past them, and the height is what matters — the
     width is only used for a prompt bubble's shrink-to-fit box. */
  content-visibility: auto;
  contain-intrinsic-size: auto 420px 520px;
}
/* A bordered block that opens a message is level with the avatar beside it: both
   are boxes, so their top edges meet. Text is left alone — its line box already
   starts at the message's top, and the avatar is set to sit just below it. */
.assistant-bubble > :first-child:not(.markdown) {
  margin-top: var(--avatar-top);
}
.user-bubble {
  background: var(--bubble-user);
  border-radius: var(--radius-lg);
  padding: 9px 14px;
}
/* A link that lands on a message marks it for a moment, so the reader sees which
   one the URL named instead of hunting for it in a screenful of conversation.
   The ring is drawn around the bubble rather than the row: the row carries no
   box of its own, and its metadata hangs outside it. */
.message.anchor-flash .bubble {
  animation: anchor-flash 1.6s ease-out;
}
@keyframes anchor-flash {
  0%,
  40% {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 45%, transparent);
  }
  100% {
    box-shadow: 0 0 0 3px transparent;
  }
}
.user-text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.error {
  margin-top: 8px;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  border-radius: var(--radius-sm);
  color: var(--danger);
  font-size: 13px;
}
/* A stop, not a failure: the same note in the quiet tone, so an interrupted
   step does not read as something going wrong. */
.error.stopped {
  border-color: var(--border);
  background: var(--bg-elevated);
  color: var(--text-muted);
}
.retry {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-faint);
  font-family: var(--font-mono);
}
/* A reply the model was cut off on: a warning toned with the accent rather than
   the error red, since nothing failed — there is just more to say. */
.truncated {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 8px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 12.5px;
}
.truncated-continue {
  flex: none;
  padding: 3px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
}
.truncated-continue:hover {
  background: color-mix(in srgb, var(--accent) 15%, transparent);
}
/* Shell commands run from the composer are shown as a compact card. */
.shell-row {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-left: 40px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  font-size: 12.5px;
  /* A command is clipped at the card's own padding box: it wraps first, and this
     is what keeps a stretch of it from being drawn across the border. */
  overflow: hidden;
}
.shell-icon {
  flex: none;
  color: var(--text-muted);
}
.shell-command {
  /* A flex item will not shrink below its content without this. `anywhere` is
     already what makes the break opportunities count, but the two together are
     what let a command with no spaces in it wrap instead of pushing. */
  min-width: 0;
  font-family: var(--font-mono);
  color: var(--text);
  overflow-wrap: anywhere;
}
.shell-status {
  margin-left: auto;
  color: var(--text-faint);
  font-size: 11px;
}
.shell-output {
  flex-basis: 100%;
  margin: 0;
  max-height: 240px;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* Rows without a bubble (notices, compaction, shell) lay out from the left.
   Items with `margin: … auto` still center themselves. */
.note-row {
  justify-content: flex-start;
}
.compaction {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px auto;
  padding: 4px 12px;
  border: 1px dashed var(--border);
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--text-faint);
}
.compaction-error {
  color: var(--danger);
}
/* A turn that ended in failure with no reply to show. It is the server's own
   record, so it survives a reload — unlike the transient banner, which is only
   the immediate signal while this row is on its way. */
.turn-failure {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 2px auto;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  border-radius: var(--radius);
  color: var(--danger);
  font-size: 12.5px;
}
.turn-failure-label {
  flex: none;
  font-weight: 600;
}
.turn-failure-text {
  min-width: 0;
  overflow-wrap: anywhere;
}
.notice {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  font-size: 12.5px;
  color: var(--text-muted);
}
/* A notice long enough to be a document: one line that opens onto the whole
   text, so an instruction update does not push the conversation off screen. */
.notice.folded {
  display: block;
  padding: 0;
}
.notice-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: transparent;
  border: none;
  text-align: left;
  cursor: pointer;
  font-size: 12.5px;
  color: var(--text-muted);
  /* Clipped at its own padding box: the label fits and the preview ellipsises,
     so this is what keeps anything that would not from crossing the border. */
  overflow: hidden;
}
.notice-head:hover {
  color: var(--text);
}
.notice-label {
  /* Normally a word or two, but the server authors this string, and it can
     arrive as a whole command: shrinkable and clipped like the preview, so a long
     one is ellipsised inside the notice instead of being drawn out of it. */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}
.notice-preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.notice-chevron {
  flex: none;
  transition: transform 0.15s ease;
}
.notice-chevron.open {
  transform: rotate(90deg);
}
.notice-body {
  max-height: 260px;
  overflow: auto;
  padding: 9px 12px 10px;
  border-top: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-faint);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.notice-icon {
  flex: none;
  margin-top: 2px;
  color: var(--text-faint);
}
.notice-text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* The metadata hangs beside the avatar — in the gutter outside the content
   column, on the side that avatar hangs on — so it reads as the message's own
   rather than as something floating in the column. The date is always there; the
   model, the tokens and the cost are the part the modifier reveals. The lines are
   flush to the avatar, which is why the assistant's, hung to its left, are
   right-aligned. */
.meta {
  position: absolute;
  top: 0;
  height: 100%;
  width: max-content;
  /* The gutter the row leaves outside the content column — half of the thread's
     own width less the column — less the gap that keeps the block off the row,
     and never more than a readable measure. */
  max-width: min(360px, calc((100cqw - var(--content-width)) / 2 - 14px));
  pointer-events: none;
}
.message.assistant .meta {
  right: calc(100% + 14px);
  text-align: right;
}
.message.user .meta {
  left: calc(100% + 14px);
  text-align: left;
}
.meta-inner {
  position: sticky;
  top: -10px;
  /* Level with the avatar: the row's own padding, which absolute positioning
     measures from, plus the avatar's offset below it. */
  margin-top: calc(var(--message-pad) + var(--avatar-top));
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-faint);
}
.meta-model {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-muted);
  /* Wrapped rather than cut: the tail of a model's name — "Ultrafast" beside
     "Uncensored" — is what tells two of them apart, so it is the last thing to
     drop. Aligned with the block it sits in — right under the assistant's, like
     the rows around it — so a name that outgrows the gutter breaks onto a
     second line and still reads as one column against the avatar. */
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: inherit;
}
.meta-row {
  white-space: nowrap;
}
.meta-datetime {
  font-variant-numeric: tabular-nums;
}
/* The stamp is the message's own link. It sits where the date always sat, and is
   the one thing in the metadata block that takes a pointer — the block itself
   does not, so the gutter never steals a click from the conversation. */
.stamp {
  color: inherit;
  text-decoration: none;
  padding: 0 2px;
  margin: 0 -2px;
  border-radius: 3px;
  pointer-events: auto;
  cursor: pointer;
}
.stamp:hover,
.stamp:focus-visible {
  color: var(--text-muted);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.stamp:focus-visible {
  outline: none;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent);
}
.stamp.confirmed {
  color: var(--accent);
}
/* A thread too narrow to hang the metadata in: the gutter is gone, and there is
   nowhere beside the text for something that is always on screen. The date takes
   a line of the message's own column instead — the byline over the bubble it
   belongs to, level with the avatar — and what the modifier adds keeps out of
   the flow, hanging under the date as a card, so revealing it never pushes the
   conversation around.
 *
 * Measured on the thread rather than the window: the sidebar is what really
 * decides whether a gutter is there. The breakpoint is the content column (46rem)
 * plus the 120px of gutter each side that the date needs to fit beside the
 * avatar, less a few pixels of slack — a condition cannot read the variable, so
 * it carries the sum in its own words.
 */
@container thread (max-width: 975px) {
  .meta {
    position: static;
    height: auto;
    width: auto;
    max-width: none;
    padding-bottom: 2px;
  }
  .meta-inner {
    position: relative;
    margin-top: 0;
  }
  /* The byline follows the text it labels: left of an assistant's, right of a
     user's. */
  .message.assistant .meta {
    text-align: left;
  }
  .message.user .meta {
    text-align: right;
  }
  .meta-rest {
    position: absolute;
    top: 100%;
    left: 0;
    padding: 4px 8px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: var(--shadow);
    text-align: left;
    /* One line each rather than a wrap: the card is as wide as its longest row,
       which is what keeps it from running off the edge it hangs from. */
    width: max-content;
  }
  .message.user .meta-rest {
    left: auto;
    right: 0;
  }
}
</style>
