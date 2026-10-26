<script setup lang="ts">
import { computed, ref } from "vue"
import { Check, ChevronRight, CircleAlert, Terminal } from "lucide-vue-next"
import type { AssistantTool } from "@/api/types"
import { prettyJson, toolSummary } from "@/utils/format"
import { toolFileView, isHttpUrl, type FileView } from "@/utils/file"
import JsonBlock from "./JsonBlock.vue"
import PartFile from "./PartFile.vue"
import Spinner from "./Spinner.vue"

const props = defineProps<{ part: AssistantTool }>()
const open = ref(false)

const state = computed(() => props.part.state)

const inputObject = computed<Record<string, unknown> | null>(() =>
  state.value.status === "streaming" ? null : (state.value.input as Record<string, unknown>),
)

const summary = computed(() => toolSummary(props.part.name, inputObject.value ?? undefined))

/** The tool arguments, pretty-printed once they are valid JSON. */
const inputText = computed(() => {
  if (state.value.status === "streaming") return state.value.input
  return JSON.stringify(state.value.input ?? {}, null, 2)
})

function textOf(content: Array<{ type: string; text?: string }> | undefined): string {
  return (content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .filter(Boolean)
    .join("\n")
}

const outputText = computed(() => {
  if (state.value.status === "completed") return prettyJson(textOf(state.value.content))
  if (state.value.status === "error") {
    return [state.value.error?.message, textOf(state.value.content)].filter(Boolean).join("\n")
  }
  return ""
})

const files = computed<FileView[]>(() => {
  const current = state.value
  if (current.status !== "completed" && current.status !== "error") return []
  const out: FileView[] = []
  for (const item of current.content ?? []) {
    if (item.type === "file") out.push(toolFileView(item))
  }
  return out
})

/**
 * A picture is the point of the call, so it is shown even while the card is
 * folded; the JSON behind it stays in the body. Every other file, and any image
 * the browser cannot render, keeps its place in the card's own file list.
 */
const renderableImage = (file: FileView) => file.mime.startsWith("image/") && (file.inline || isHttpUrl(file.url))
const images = computed(() => files.value.filter(renderableImage))
const otherFiles = computed(() => files.value.filter((file) => !renderableImage(file)))

const busy = computed(() => state.value.status === "streaming" || state.value.status === "running")
</script>

<template>
  <div class="tool" :class="state.status">
    <button class="head" @click="open = !open">
      <!-- The chevron, the terminal and the text are one flowing line: a long
           argument wraps at the row's own left edge, under the chevron, instead
           of in a column indented past the icons. -->
      <span class="tool-text">
        <ChevronRight :size="14" class="chev" :class="{ open }" />
        <Terminal :size="14" class="tool-icon" />
        <span class="tool-name">{{ part.name }}</span>
        <!-- The summary continues the name's line. Its leading space is an
             interpolation because the compiler strips whitespace that sits
             between two elements. -->
        <span v-if="summary" class="tool-title">{{ " " }}{{ summary }}</span>
      </span>
      <span class="status">
        <Spinner v-if="busy" :size="12" />
        <Check v-else-if="state.status === 'completed'" :size="14" class="ok" />
        <CircleAlert v-else :size="14" class="err" />
      </span>
    </button>
    <div v-if="images.length" class="images">
      <PartFile v-for="(image, index) in images" :key="index" :file="image" />
    </div>
    <div v-show="open" class="body">
      <div class="section">
        <div class="label">Input</div>
        <JsonBlock :text="inputText" />
      </div>
      <div v-if="outputText" class="section">
        <div class="label">Output</div>
        <JsonBlock :text="outputText" />
      </div>
      <div v-if="otherFiles.length" class="section">
        <div class="label">Files</div>
        <PartFile v-for="(file, index) in otherFiles" :key="index" :file="file" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool {
  margin: 8px 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  overflow: hidden;
}
.head {
  display: flex;
  /* The status sits on the first line of the text, not on the centre of a
     summary that has wrapped to several. */
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  padding: 8px 12px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-muted);
  /* The row's content is clipped at its own padding box, so a summary can never
     be drawn across the card's border — it wraps, and this is the guarantee for
     anything that would not. */
  overflow: hidden;
}
.head:hover {
  background: var(--bg-hover);
}
/* The chevron and the terminal are the first glyphs of the text run, so a
   wrapped summary continues at the left edge instead of past the icons. */
.chev {
  display: inline-block;
  vertical-align: middle;
  margin-right: 4px;
  transition: transform 0.15s;
}
.chev.open {
  transform: rotate(90deg);
}
.tool-icon {
  display: inline-block;
  vertical-align: middle;
  margin-right: 4px;
}
/* The name and its summary: one text run, so the summary wraps under the name
   instead of being laid out as a second column beside it. */
.tool-text {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  color: var(--text-faint);
  /* A long command wraps. An ellipsis would keep the row to one line, but it
     hides the very thing worth reading, and letting the line run on gives the
     conversation a horizontal scrollbar instead. */
  overflow-wrap: anywhere;
}
.tool-name {
  color: var(--text);
}
.status {
  flex: none;
  display: inline-flex;
  margin-top: 2px;
}
.ok {
  color: #4ade80;
}
.err {
  color: var(--danger);
}
.body {
  border-top: 1px solid var(--border);
  padding: 8px 12px 10px;
}
/* A picture a tool produced shows without the body being expanded. */
.images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 12px 10px;
}
.section + .section {
  margin-top: 8px;
}
.label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
  margin-bottom: 4px;
}
</style>
