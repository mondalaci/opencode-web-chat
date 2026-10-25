/**
 * The conversation vocabulary, shared with the studio app.
 *
 * A conversation is in one of four states, folded from signals that arrive from
 * different places: the session status stream, the project's pending permission
 * and question requests, and whether a finished turn was watched. The
 * precedence is the studio app's own (`src/utils/sessionState.ts` there), so a
 * web chat describes a conversation with the same words the desktop app does —
 * which is what lets one chime policy and one tray icon serve both.
 *
 *   blocked > working > done (unacknowledged) > idle
 */

/** What a conversation shows in the sidebar, and what the tray summarises. */
export type ConversationState = "blocked" | "working" | "done" | "idle"

/** Most actionable first; the index doubles as the rank. */
export const STATE_PRECEDENCE: ConversationState[] = ["blocked", "working", "done", "idle"]

/**
 * The reason a conversation shows while an agent question waits for an answer.
 *
 * "Blocked" covers both a question and a permission request, so the reason is
 * what tells the two apart — the chime keys off it, and so does anything else
 * that wants to know which kind of interruption this is.
 */
export const QUESTION_REASON = "question"

/** Raw signals for one conversation. */
export interface ConversationSignals {
  /** Pending permission request or question: the agent needs a human. */
  blocked?: boolean
  /** Session status as the server reports it: idle, busy, retry, offline. */
  status?: string
  /** Finished since the user last looked at it. */
  unread?: boolean
}

/** Human-readable reason, for the tray tooltip. */
export function stateLabel(state: ConversationState, signals: ConversationSignals = {}): string {
  if (state === "blocked") return signals.status === "offline" ? "offline" : "blocked"
  if (state === "working") return signals.status === "retry" ? "retrying" : "working"
  if (state === "done") return "done"
  return "idle"
}

/** Fold the raw signals into the state a dot shows. */
export function conversationState(signals: ConversationSignals): ConversationState {
  if (signals.blocked) return "blocked"
  // An offline request is waiting on something outside the agent, so it needs the
  // user the same way a blocked one does.
  if (signals.status === "offline") return "blocked"
  if (signals.status === "busy" || signals.status === "retry") return "working"
  if (signals.unread) return "done"
  return "idle"
}

/** The most actionable state in a set, by the precedence above. */
export function worstState(states: ConversationState[]): ConversationState {
  let best: ConversationState = "idle"
  for (const state of states) {
    if (STATE_PRECEDENCE.indexOf(state) < STATE_PRECEDENCE.indexOf(best)) best = state
  }
  return best
}

/** Whether a string off the wire is one of the four states. */
export function isConversationState(value: unknown): value is ConversationState {
  return value === "blocked" || value === "working" || value === "done" || value === "idle"
}
