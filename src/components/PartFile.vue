<script setup lang="ts">
import { computed, ref } from "vue"
import { Check, ChevronDown, ChevronRight, Copy, Download, File as FileIcon, ExternalLink } from "lucide-vue-next"
import { dataUrlByteLength, dataUrlText, dataUrlToBlob, formatBytes, isDataUrl, isHttpUrl, isTextMime, type FileView } from "@/utils/file"
import { openImage } from "@/stores/lightbox"

const props = defineProps<{ file: FileView }>()

/** Cap inline previews so a huge text file cannot freeze the view. */
const MAX_PREVIEW = 100_000

const url = computed(() => props.file.url)
const mime = computed(() => props.file.mime ?? "")
const name = computed(() => props.file.name || mime.value || "file")

/** Content that travels with the message (data URL) can be shown and saved. */
const hasBytes = computed(() => props.file.inline && isDataUrl(url.value))
const isRemote = computed(() => isHttpUrl(url.value))
const isImage = computed(() => mime.value.startsWith("image/") && (hasBytes.value || isRemote.value))
const showable = computed(() => hasBytes.value || isRemote.value)
const size = computed(() => (hasBytes.value ? dataUrlByteLength(url.value) : 0))

const previewText = computed(() => (hasBytes.value && isTextMime(mime.value) ? dataUrlText(url.value) : null))
const truncated = computed(() => previewText.value != null && previewText.value.length > MAX_PREVIEW)

const expanded = ref(false)
const copied = ref(false)

function toggle() {
  if (isRemote.value) {
    window.open(url.value, "_blank", "noopener")
    return
  }
  if (!showable.value) return
  expanded.value = !expanded.value
}

function download() {
  const blob = hasBytes.value ? dataUrlToBlob(url.value) : null
  const href = blob ? URL.createObjectURL(blob) : url.value
  const anchor = document.createElement("a")
  anchor.href = href
  anchor.download = name.value
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  if (blob) setTimeout(() => URL.revokeObjectURL(href), 1000)
}

function openInTab() {
  if (isRemote.value) {
    window.open(url.value, "_blank", "noopener")
    return
  }
  const blob = hasBytes.value ? dataUrlToBlob(url.value) : null
  if (!blob) return
  const href = URL.createObjectURL(blob)
  window.open(href, "_blank", "noopener")
  setTimeout(() => URL.revokeObjectURL(href), 60_000)
}

async function copy() {
  if (previewText.value == null) return
  try {
    await navigator.clipboard.writeText(previewText.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1200)
  } catch {
    /* clipboard unavailable */
  }
}
</script>

<template>
  <div class="part-file">
    <img
      v-if="isImage"
      :src="url"
      :alt="name"
      class="zoomable"
      title="Click to enlarge"
      @click="openImage(url, name)"
    />

    <template v-else>
      <button
        type="button"
        class="file-chip"
        :class="{ static: !showable }"
        :title="isRemote ? `Open ${name}` : props.file.reference && !showable ? props.file.reference : `Show ${name}`"
        @click="toggle"
      >
        <ChevronDown v-if="expanded" :size="14" />
        <ChevronRight v-else :size="14" />
        <FileIcon :size="14" />
        <span class="file-name">{{ name }}</span>
        <span v-if="size" class="file-size">{{ formatBytes(size) }}</span>
      </button>

      <div v-if="expanded && hasBytes" class="file-preview">
        <div class="preview-actions">
          <button type="button" title="Download" @click="download"><Download :size="13" /> Download</button>
          <button type="button" title="Open in a new tab" @click="openInTab"><ExternalLink :size="13" /> Open</button>
          <button v-if="previewText != null" type="button" title="Copy contents" @click="copy">
            <Check v-if="copied" :size="13" />
            <Copy v-else :size="13" />
            {{ copied ? "Copied" : "Copy" }}
          </button>
        </div>
        <pre v-if="previewText != null" class="preview-text">{{ truncated ? previewText.slice(0, MAX_PREVIEW) : previewText }}</pre>
        <p v-else class="preview-binary">No inline preview for {{ mime || "this file type" }}. Use Download or Open.</p>
      </div>
      <p v-else-if="!showable && props.file.reference" class="file-reference">{{ props.file.reference }}</p>
    </template>
  </div>
</template>

<style scoped>
.part-file {
  margin: 6px 0;
}
.part-file img {
  max-width: 100%;
  max-height: 360px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
}
.part-file img.zoomable {
  cursor: zoom-in;
}
.file-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text);
  font-size: 12.5px;
  text-align: left;
}
.file-chip:hover {
  border-color: var(--border-strong);
}
.file-chip.static {
  cursor: default;
}
.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-size {
  color: var(--text-muted);
  flex: none;
}
.file-reference {
  margin: 2px 0 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-faint);
  overflow-wrap: anywhere;
}
.file-preview {
  margin-top: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  overflow: hidden;
}
.preview-actions {
  display: flex;
  gap: 4px;
  padding: 6px;
  border-bottom: 1px solid var(--border);
}
.preview-actions button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text-muted);
  font-size: 12px;
}
.preview-actions button:hover {
  color: var(--text);
  border-color: var(--border-strong);
}
.preview-text {
  margin: 0;
  padding: 10px 12px;
  max-height: 420px;
  overflow: auto;
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.preview-binary {
  margin: 0;
  padding: 12px;
  font-size: 12.5px;
  color: var(--text-muted);
}
</style>
