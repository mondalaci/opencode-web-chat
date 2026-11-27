import type { SessionMessageAssistant, AssistantContent, AssistantTool } from "@/api/types"
import { composedMessage } from "./compose"

/**
 * The blocks of an assistant message, as the thread draws them.
 *
 * A block with no text in it is dropped rather than drawn. An empty text block is
 * a streamed blank first frame; an empty reasoning block is worse, because the
 * only thing it has to show is the border beside a message's thinking — so it
 * lands as a stub above what follows, and one that sits in front of the reasoning
 * of the same step leaves that border looking cut in two. The server writes both
 * (a `reasoning.ended` carrying nothing arrives on its own), so the filter is on
 * what is drawn and the message behind it is left alone.
 *
 * The reasoning that survives is joined into one block, for the same reason: the
 * bar beside a message's thinking is meant to read as one piece, and the pieces
 * the server sends — it does split a step's reasoning around an empty one —
 * would otherwise be drawn with the collapsed margin's gap between them.
 */
export function drawnBlocks(message: SessionMessageAssistant): AssistantContent[] {
  const filled = message.content.filter((block) =>
    block.type === "text" || block.type === "reasoning" ? block.text.trim() !== "" : true,
  )
  const drawn: AssistantContent[] = []
  for (const block of filled) {
    const previous = drawn[drawn.length - 1]
    if (block.type === "reasoning" && previous?.type === "reasoning") {
      drawn[drawn.length - 1] = {
        ...previous,
        // Joined where the words meet: the blank line between them is the seam,
        // and any the pieces carried on their own would only be height.
        text: `${previous.text.trimEnd()}\n\n${block.text.trimStart()}`,
        // The join is as settled as the block it ends on, which is what decides
        // whether the bar is still being written to.
        time: block.time ?? previous.time,
      }
      continue
    }
    drawn.push(block)
  }
  return drawn
}

/**
 * Whether a block is something to read rather than a step taken to produce it.
 *
 * A message compose is a tool call, but the draft it carries *is* the reply the
 * reader asked for — hiding it in a compact view would throw away the point of
 * the turn — so it reads as content. A picture a tool returned is the same kind
 * of thing: a screenshot read from disk, an image the model generated. The call
 * is how it got here; the image is what there is to look at. Everything else that
 * is not a text block is a step: reasoning to be thought through, or a call to
 * watch.
 */
export function readableBlock(block: AssistantContent): boolean {
  if (block.type === "text") return true
  if (block.type !== "tool") return false
  return composedMessage(block) !== null || carriesImage(block)
}

/** Whether a tool's own result is a picture, drawn by the tool card. */
function carriesImage(block: AssistantTool): boolean {
  const current = block.state
  if (current.status !== "completed" && current.status !== "error") return false
  return (current.content ?? []).some((item) => item.type === "file" && item.mime.startsWith("image/"))
}
