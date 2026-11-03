<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue"
import { X } from "lucide-vue-next"
import { closeImage, lightboxImage } from "@/stores/lightbox"

/**
 * The enlarged view of an image from a conversation.
 *
 * It covers the whole window — sidebars and dialogs included, since "full size
 * in the window" means the largest the screen allows — and dismisses on a click
 * anywhere or Escape, which puts the thread's own size back on screen.
 */
function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && lightboxImage.value) {
    event.stopPropagation()
    closeImage()
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown))
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown))
</script>

<template>
  <div
    v-if="lightboxImage"
    class="lightbox"
    role="dialog"
    aria-modal="true"
    :aria-label="lightboxImage.alt || 'Image'"
    title="Click to return to the conversation"
    @click="closeImage()"
  >
    <button class="close" type="button" title="Close (Esc)" @click.stop="closeImage()"><X :size="18" /></button>
    <img :src="lightboxImage.src" :alt="lightboxImage.alt" />
    <p v-if="lightboxImage.alt" class="caption">{{ lightboxImage.alt }}</p>
  </div>
</template>

<style scoped>
.lightbox {
  position: fixed;
  inset: 0;
  /* Above the panels and the dialogs, since it covers them. */
  z-index: 200;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  background: color-mix(in srgb, #000 78%, transparent);
  cursor: zoom-out;
}
.lightbox img {
  max-width: 100%;
  max-height: calc(100% - 40px);
  object-fit: contain;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  cursor: zoom-out;
}
.caption {
  max-width: 90%;
  margin: 0;
  font-size: 12px;
  color: #e6e6e6;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.close {
  position: absolute;
  top: 10px;
  right: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.12);
  color: #ffffff;
}
.close:hover {
  background: rgba(255, 255, 255, 0.24);
}
</style>
