<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import type { AssistantReasoning } from "@/api/types"
import Spinner from "./Spinner.vue"

const props = defineProps<{ part: AssistantReasoning }>()
const streaming = computed(() => !props.part.time?.completed)

/**
 * The reasoning as it is read.
 *
 * A streamed block leads and trails with blank lines — the paragraph breaks the
 * model writes — and in a pre-wrapped body those are line boxes like any other:
 * they hold the box open past the last word, with the border hanging over the gap
 * beside them. The box is meant to end with the reasoning, so the whitespace at
 * its two ends goes.
 */
const text = computed(() => props.part.text.trim())

const body = ref<HTMLElement | null>(null)

watch(
  () => props.part.text,
  async () => {
    if (!streaming.value) return
    await nextTick()
    const el = body.value
    if (el) el.scrollTop = el.scrollHeight
  },
)
</script>

<template>
  <div class="reasoning">
    <div v-if="streaming" class="head" aria-hidden="true">
      <Spinner :size="14" />
    </div>
    <div ref="body" class="body">{{ text }}</div>
  </div>
</template>

<style scoped>
.reasoning {
  position: relative;
  margin: 6px 0;
  border-left: 2px solid var(--border);
  /* The space above the body is padding, not the body's own margin: a child's top
     margin collapses out of this box, which left the accent bar starting below the
     block's top edge and pushed the whole box out of line with the avatar. */
  padding: 6px 0 0 10px;
}
/* Streaming indicator in the right gutter, mirroring the assistant avatar on the left. */
.head {
  position: absolute;
  top: 0;
  left: calc(100% + 10px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--text-faint);
  opacity: 0.6;
}
.body {
  margin-top: 0;
  color: var(--text-muted);
  font-size: 13px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 100px;
  overflow-y: auto;
}
/* No right gutter on narrow viewports: fall back to overlaying the content. */
@media (max-width: 880px) {
  .head {
    left: auto;
    right: 0;
  }
}
</style>
