<script setup lang="ts">
import { computed, ref } from "vue"
import { ChevronRight, Info, Sparkles, Terminal, User } from "lucide-vue-next"
import type {
  AssistantContent,
  AssistantTool,
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionMessageShell,
} from "@/api/types"
import { formatCost, formatDateTime, formatTokens } from "@/utils/format"
import { attachmentView } from "@/utils/file"
import { composedMessage } from "@/utils/compose"
import { shortcutsVisible } from "@/stores/shortcuts"
import { useServer } from "@/stores/server"
import Markdown from "./Markdown.vue"
import PartFile from "./PartFile.vue"
import PartMessageCompose from "./PartMessageCompose.vue"
import PartReasoning from "./PartReasoning.vue"
import PartTool from "./PartTool.vue"

const props = defineProps<{ message: SessionMessageInfo; streaming?: boolean }>()

/** The model list, for naming the model a message ran on. */
const { models } = useServer()

const kind = computed(() => props.message.type)
const isUser = computed(() => kind.value === "user")
const isAssistant = computed(() => kind.value === "assistant")

/**
 * Message types that only record state (the agent/model switched away, the
 * session went idle) carry nothing to display, so they are skipped entirely
 * instead of leaving an empty row behind.
 */
const renders = computed(() => !["idle", "agent-switched", "model-switched", "location-switched"].includes(kind.value))

const assistant = computed(() => (isAssistant.value ? (props.message as SessionMessageAssistant) : null))

/** Assistant output blocks with empty text skipped (a streamed blank first frame). */
const content = computed<AssistantContent[]>(() => {
  const message = assistant.value
  if (!message) return []
  return message.content.filter((block) => block.type !== "text" || block.text.trim())
})

const userText = computed(() => (props.message.type === "user" ? props.message.text : ""))
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

/** A turn waiting to try again after a failed step. */
const retryNote = computed(() => {
  const retry = assistant.value?.retry
  return retry ? `Retrying (attempt ${retry.attempt})…` : null
})

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

const meta = computed(() => {
  const message = assistant.value
  if (!message) return null
  const tokens = message.tokens
  const total = tokens ? (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) : 0
  return {
    model: modelLabel.value?.text ?? "",
    reference: modelLabel.value?.reference ?? "",
    tokens: total,
    cost: message.cost ?? 0,
    created: message.time?.created,
  }
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
  <div v-if="renders" class="message" :class="isUser ? 'user' : isAssistant ? 'assistant' : 'note-row'">
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

    <div
      v-if="isUser"
      class="bubble user-bubble"
    >
      <p v-if="userText" class="user-text">{{ userText }}</p>
      <PartFile v-for="(file, index) in userFiles" :key="index" :file="file" />
    </div>

    <div v-else-if="isAssistant" class="bubble assistant-bubble">
      <template v-for="(block, index) in content" :key="index">
        <Markdown v-if="block.type === 'text'" :text="block.text" :streaming="streaming" />
        <PartReasoning v-else-if="block.type === 'reasoning'" :part="block" />
        <template v-else-if="block.type === 'tool'">
          <PartMessageCompose v-if="isCompose(block)" :part="block" />
          <PartTool v-else :part="block" />
        </template>
      </template>

      <div v-if="streaming" class="caret"></div>
      <div v-if="errorMessage" class="error">{{ errorMessage }}</div>
      <div v-if="retryNote" class="retry">{{ retryNote }}</div>
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

    <div v-if="meta && !streaming && shortcutsVisible" class="meta" :title="meta.reference || meta.model">
      <div class="meta-inner">
        <div v-if="meta.created" class="meta-row meta-datetime">{{ formatDateTime(meta.created) }}</div>
        <div class="meta-model">{{ meta.model }}</div>
        <div v-if="meta.tokens" class="meta-row">{{ formatTokens(meta.tokens) }} tokens</div>
        <div v-if="meta.cost" class="meta-row">{{ formatCost(meta.cost) }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.message {
  position: relative;
  display: flex;
  gap: 12px;
  padding: 10px 0;
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
.bubble {
  min-width: 0;
  max-width: 100%;
}
.assistant-bubble {
  flex: 1;
  /* Stop one gutter short of the column edge, where the user's bubble stops, so
     the assistant's content and the user's share one width and both avatars
     protrude past it. */
  margin-right: var(--avatar-gutter);
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
  max-width: 80%;
}
.user-text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.caret {
  display: inline-block;
  width: 8px;
  height: 15px;
  background: var(--text);
  vertical-align: text-bottom;
  animation: opencode-blink 1s step-start infinite;
}
@keyframes opencode-blink {
  50% {
    opacity: 0;
  }
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
.retry {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-faint);
  font-family: var(--font-mono);
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
.meta {
  position: absolute;
  top: 0;
  left: calc(100% + 14px);
  height: 100%;
  width: max-content;
  max-width: min(360px, calc(50vw - var(--content-width) / 2 - 40px));
  pointer-events: none;
}
.meta-inner {
  position: sticky;
  top: -10px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-faint);
}
.meta-model {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta-row {
  white-space: nowrap;
}
.meta-datetime {
  font-variant-numeric: tabular-nums;
}
@media (max-width: 1360px) {
  .meta {
    top: 6px;
    left: auto;
    right: 4px;
    height: auto;
    width: auto;
    max-width: none;
  }
  .meta-inner {
    position: static;
    padding: 4px 8px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: var(--shadow);
  }
}
</style>
