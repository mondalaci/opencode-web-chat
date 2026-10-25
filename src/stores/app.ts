import type { Credentials, PromptFileInput } from "@/api/client"
import type { InstanceInfo } from "@/api/discovery"
import type { FormAnswer, FormInfo, Model, SessionInfo } from "@/api/types"
import { archiveOpen, useArchive } from "./archive"
import { useChat } from "./chat"
import { useConnection } from "./connection"
import { draft, requestComposerFocus } from "./draft"
import { useLive } from "./live"
import { usePresence } from "./presence"
import { toModelRef, useServer } from "./server"
import { useSessions } from "./sessions"
import {
  clearProjectParam,
  clearPromptParams,
  readAutoSubmitParam,
  readProjectParam,
  readQueryParam,
  readSessionParam,
  writeSessionParam,
} from "@/utils/url"

export function useApp() {
  const connection = useConnection()
  const server = useServer()
  const sessions = useSessions()
  const chat = useChat()
  const live = useLive()
  const presence = usePresence()
  const archive = useArchive()

  async function connect(info: InstanceInfo, credentials?: Credentials) {
    live.stop()
    chat.reset()
    sessions.reset()
    server.reset()
    presence.reset()

    server.applySavedPrefs(info.origin)

    const ok = await connection.connect(info, credentials)
    const client = connection.client.value
    if (!ok || !client) return false

    try {
      const origin = connection.connected.value?.origin ?? info.origin
      // A `?project=` link (the launcher's vocab shortcut) scopes this visit to
      // that project without changing the project the app remembers. Without one,
      // `load` falls back to the project chosen for this server, then to the
      // runtime config's first shown project, then to the server's own default —
      // so the server's default is passed along rather than decided here.
      const linked = readProjectParam()
      if (linked) clearProjectParam()
      const fallback = (await client.locationInfo().catch(() => null))?.directory
      await server.load(client, origin, linked ?? undefined, fallback)
      await sessions.load(client, server.directory.value)
      live.start(client, server.directory.value)
      await openSessionFromUrl()
      await applyLinkParams()
      return true
    } catch (error) {
      live.stop()
      chat.reset()
      sessions.reset()
      server.reset()
      presence.reset()

      connection.disconnect()
      connection.connectError.value = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  function disconnect() {
    live.stop()
    chat.reset()
    sessions.reset()
    server.reset()
    presence.reset()
    archive.reset()
    connection.disconnect()
  }

  async function selectSession(sessionID: string) {
    const client = connection.client.value
    if (!client) return
    sessions.currentID.value = sessionID
    writeSessionParam(sessionID, readSessionParam() === sessionID)
    // Refresh the session info so the header reflects fields the list omits.
    const info = await client.getSession(sessionID).catch(() => null)
    if (info) {
      sessions.upsert(info)
      server.applySession(info)
    }
    await chat.open(client, sessionID, server.directory.value)
  }

  /** Open a session by id, switching project first if it lives elsewhere. */
  async function openSessionByID(sessionID: string) {
    const client = connection.client.value
    if (!client) return false
    const info = await client.getSession(sessionID).catch(() => null)
    if (!info) return false
    const directory = info.location?.directory
    if (directory && directory !== server.directory.value) await switchProject(directory)
    await selectSession(sessionID)
    return true
  }

  /** Apply the session id from the current URL (used on load and back/forward). */
  async function openSessionFromUrl() {
    const id = readSessionParam()
    if (id) await openSessionByID(id)
  }

  /**
   * Apply one-time link params (`?query=`, `?submit=`) after a connection is
   * established. The query is prefilled into the composer; with `submit` it is
   * sent right away (creating a new chat if none is open) and the params are
   * cleared so a reload does not resend it.
   */
  async function applyLinkParams() {
    const query = readQueryParam()
    if (query !== null) draft.value = query

    if (!readAutoSubmitParam()) return
    const text = draft.value.trim()
    clearPromptParams()
    if (!text) return
    await sendMessage(text)
    draft.value = ""
  }

  /** Switch the active project (location) and reload everything scoped to it. */
  async function switchProject(directory: string) {
    const client = connection.client.value
    if (!client) return
    if (server.directory.value === directory) return
    chat.reset()
    sessions.reset()
    // The open chat (if any) belongs to the previous project; drop it from the
    // URL too so a reload does not jump straight back to it.
    writeSessionParam(null)
    server.setDirectory(directory)
    await server.load(client, connection.connected.value?.origin ?? "", directory)
    await sessions.load(client, server.directory.value)
    live.setDirectory(server.directory.value)
    // The archive belongs to the project, so an open one follows the switch.
    if (archiveOpen.value) await archive.load(client, directory)
  }

  async function newChat() {
    const client = connection.client.value
    if (!client) return null
    const session = await sessions.create(
      client,
      { agent: server.agent, model: server.selectedModel.value ?? undefined },
      server.directory.value,
    )
    await selectSession(session.id)
    requestComposerFocus()
    return session
  }

  /** Select a model (optionally with a variant), applying it to the open chat. */
  async function setModel(model: Model | { providerID: string; modelID?: string; id?: string; variant?: string }, variant?: string) {
    const ref = toModelRef(model as Model)
    const next = variant ? { ...ref, variant } : ref
    server.setModelLocal(next)
    const client = connection.client.value
    const sessionID = sessions.currentID.value
    if (!client || !sessionID) return
    await client.switchModel(sessionID, next).catch(() => undefined)
    const info = sessions.sessions.value.find((item) => item.id === sessionID)
    if (info) sessions.upsert({ ...info, model: next })
  }

  /** Switch the reasoning-effort variant of the current model. */
  async function setVariant(variant: string) {
    const current = server.selectedModel.value
    if (!current) return
    await setModel(current, variant)
  }

  async function sendMessage(text: string, files: PromptFileInput[] = []) {
    const client = connection.client.value
    if (!client) return
    const content = text.trim()
    if (!content && files.length === 0) return
    let sessionID = sessions.currentID.value
    if (!sessionID) {
      const session = await newChat()
      if (!session) return
      sessionID = session.id
    }
    // The agent, model and image model travel with the message: the first two are
    // session state in v2 and the picker's choice may not have reached the
    // session yet, while the last is per-turn metadata the image tool reads.
    await chat.send(client, sessionID, {
      text: content,
      files,
      model: server.selectedModel.value ?? undefined,
      agent: server.agent,
      imageModel: server.selectedImageModel.value,
    })
  }

  async function abort() {
    const client = connection.client.value
    const sessionID = sessions.currentID.value
    if (!client || !sessionID) return
    await chat.abort(client, sessionID)
  }

  /**
   * Hand a slash command to the server.
   *
   * A command belongs to a conversation, so an empty pane gets one first —
   * exactly as `sendMessage` does — and the command then expands into the
   * prompt that opens it.
   */
  async function runCommand(name: string, text: string, files: PromptFileInput[] = []) {
    const client = connection.client.value
    if (!client) return
    let sessionID = sessions.currentID.value
    if (!sessionID) {
      const session = await newChat()
      if (!session) return
      sessionID = session.id
    }
    await chat.runCommand(client, sessionID, { name, text, files })
  }

  /** Compact the open conversation, as the TUI's `/compact` does. */
  async function compact() {
    const client = connection.client.value
    const sessionID = sessions.currentID.value
    if (!client || !sessionID) return
    await chat.compact(client, sessionID)
  }

  /**
   * Put a conversation out of the way, reversibly.
   *
   * Deleting is offered only from the archive view, which asks for a
   * confirmation first: the API has no undelete.
   */
  async function archiveSession(sessionID: string) {
    const client = connection.client.value
    if (!client) return
    await sessions.archive(client, sessionID)
    if (!sessions.currentID.value && sessions.sorted.value[0]) {
      await selectSession(sessions.sorted.value[0].id)
    }
  }

  async function openArchive() {
    const client = connection.client.value
    if (!client) return
    archiveOpen.value = true
    await archive.load(client, server.directory.value)
  }

  function closeArchive() {
    archiveOpen.value = false
  }

  /** Show an archived conversation in the pane, without leaving the archive. */
  async function viewArchivedSession(session: SessionInfo) {
    const client = connection.client.value
    if (!client) return
    sessions.previewSession(session)
    writeSessionParam(session.id, readSessionParam() === session.id)
    await chat.open(client, session.id, server.directory.value)
  }

  /** Take a conversation back out of the archive, into the visible list. */
  async function restoreSession(sessionID: string) {
    const client = connection.client.value
    if (!client) return
    await sessions.unarchive(client, sessionID)
    archive.remove(sessionID)
    const info = await client.getSession(sessionID).catch(() => null)
    if (info) {
      sessions.upsert(info)
      if (sessions.currentID.value === sessionID) sessions.clearPreview()
    }
  }

  /** Delete a conversation for good. Only the archive view offers this. */
  async function deleteSession(sessionID: string) {
    const client = connection.client.value
    if (!client) return
    await sessions.remove(client, sessionID)
    archive.remove(sessionID)
    if (!sessions.currentID.value && sessions.sorted.value[0]) {
      await selectSession(sessions.sorted.value[0].id)
    }
  }

  async function renameSession(sessionID: string, title: string) {
    const client = connection.client.value
    if (!client) return
    await sessions.rename(client, sessionID, title)
  }

  async function replyPermission(sessionID: string, requestID: string, decision: "once" | "always" | "reject") {
    const client = connection.client.value
    if (!client) return
    await chat.replyPermission(client, requestID, sessionID, decision)
  }

  async function replyForm(form: FormInfo, answer: FormAnswer) {
    const client = connection.client.value
    if (!client) return
    await chat.replyForm(client, form.sessionID, form.id, answer)
  }

  async function cancelForm(form: FormInfo) {
    const client = connection.client.value
    if (!client) return
    await chat.cancelForm(client, form.sessionID, form.id)
  }

  /** The openai-compatible key the server holds for an integration (TTS). */
  async function integrationKey(integrationID: string): Promise<string | null> {
    const client = connection.client.value
    if (!client) return null
    return client.credentialKey(integrationID)
  }

  return {
    connection,
    server,
    sessions,
    chat,
    live,
    archive,
    connect,
    disconnect,
    selectSession,
    switchProject,
    openSessionFromUrl,
    openSessionByID,
    newChat,
    sendMessage,
    runCommand,
    compact,
    abort,
    archiveSession,
    openArchive,
    closeArchive,
    viewArchivedSession,
    restoreSession,
    deleteSession,
    renameSession,
    setModel,
    setVariant,
    replyPermission,
    replyForm,
    cancelForm,
    integrationKey,
  }
}

export type AppStore = ReturnType<typeof useApp>
