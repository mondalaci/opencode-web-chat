import { ClientError, OpenCode, isUnauthorizedError } from "@opencode/client"
import type {
  Agent,
  CommandInfo,
  ConfigEntry,
  FormAnswer,
  FormInfo,
  IntegrationAttempt,
  IntegrationAttemptStatus,
  IntegrationInfo,
  LocationPublicInfo,
  McpServer,
  Model,
  ModelRef,
  PermissionRequest,
  Project,
  SessionActive,
  SessionInfo,
  SessionMessageID,
  SessionMessageInfo,
  SkillInfo,
  Provider,
  V2Event,
} from "./types"

export interface Credentials {
  username: string
  password: string
}

/** Username the opencode server expects alongside its service password. */
export const DEFAULT_USERNAME = "opencode"

/**
 * Deadline for a single request, in ms.
 *
 * A request that never settles keeps its socket open for ever. A handful of
 * those exhaust the browser's per-origin connection pool, after which every
 * later request (health probes included) queues indefinitely and the app looks
 * dead. So each call carries a deadline it aborts on; streams opt out of it.
 */
const DEFAULT_TIMEOUT_MS = 30_000

/** Per-call transport knobs, honoured by every method below. */
export interface CallOptions {
  /** Deadline in ms; `0` disables it (a stream runs until it is aborted). */
  timeoutMs?: number
  /** Abort the call from the outside, e.g. when the session changes. */
  signal?: AbortSignal
}

/**
 * HTTP status of every error tag the server can answer with, so a failure keeps
 * its meaning after it has been folded into `ServerError`.
 */
const ERROR_STATUS: Record<string, number> = {
  InvalidRequestError: 400,
  InvalidCursorError: 400,
  FormInvalidAnswerError: 400,
  UnauthorizedError: 401,
  ForbiddenError: 403,
  SessionNotFoundError: 404,
  MessageNotFoundError: 404,
  LocationNotFoundError: 404,
  ProjectNotFoundError: 404,
  ProviderNotFoundError: 404,
  AgentNotFoundError: 404,
  FormNotFoundError: 404,
  CommandNotFoundError: 404,
  SkillNotFoundError: 404,
  FileNotFoundError: 404,
  ShellNotFoundError: 404,
  McpServerNotFoundError: 404,
  IntegrationNotFoundError: 404,
  PermissionNotFoundError: 404,
  PermissionSavedNotFoundError: 404,
  SessionBusyError: 409,
  ConflictError: 409,
  FormAlreadySettledError: 409,
  InstructionEntryValueTooLargeError: 413,
  UnknownError: 500,
  CommandExecutionError: 500,
  RpcInternalError: 500,
  ServiceUnavailableError: 503,
  VcsInitNotSupportedError: 501,
}

/** A normalized transport/HTTP failure the UI can present. */
export class ServerError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The server's own error tag, when it answered with one. */
    public tag?: string,
  ) {
    super(message)
    this.name = "ServerError"
  }

  get unauthorized() {
    return this.status === 401
  }
}

/**
 * Declared API failures (the generated client throws tagged values such as
 * `{_tag: "SessionNotFoundError"}`) and transport failures are folded into one
 * error type so callers do not need to know which layer failed.
 */
export function toServerError(error: unknown): ServerError {
  if (error instanceof ServerError) return error
  const tagged = error as { _tag?: string; message?: string } | null
  const tag = tagged?._tag
  if (typeof tag === "string") {
    const status = ERROR_STATUS[tag]
    if (status) return new ServerError(status, tagged?.message || tag, tag)
  }
  if (isUnauthorizedError(error)) return new ServerError(401, "Authentication required", "UnauthorizedError")
  // The generated client folds the response detail (or the cause's message) into
  // its own message, so a transport failure or an aborted call still reads well.
  if (error instanceof ClientError) return new ServerError(0, error.message)
  if (error instanceof Error) return new ServerError(0, error.message)
  return new ServerError(0, String(error))
}

export interface SessionPage {
  data: SessionInfo[]
  /** Opaque cursor for the next page, or null at the end of the list. */
  next: string | null
}

export interface MessagePage {
  data: SessionMessageInfo[]
  /**
   * Opaque cursor for the next page in the requested order, or null at the end.
   *
   * Only the `next` cursor can be followed: the server encodes an order and a
   * direction into it, and a `previous` cursor comes back as an empty page.
   */
  next: string | null
}

export interface PromptFileInput {
  /** A `data:` URL (`data:<mime>;base64,<payload>`) or a file/http URI. */
  uri: string
  name?: string
}

export interface ConfigValues {
  /** Merged `model` string (`provider/model`) from the config documents. */
  model?: string
  defaultAgent?: string
  username?: string
}

/**
 * Thin wrapper over the generated `@opencode/client` client.
 *
 * Its job is to (a) attach the server's HTTP Basic credentials, (b) scope
 * calls to the selected project directory, (c) give every request a deadline
 * and (d) normalize errors, so the stores never deal with transport details.
 */
export class ServerClient {
  readonly origin: string
  private readonly sdk: ReturnType<typeof OpenCode.make>

  constructor(origin: string, credentials?: Credentials) {
    this.origin = origin.replace(/\/+$/, "")
    const headers = credentials?.password
      ? { authorization: `Basic ${btoa(`${credentials.username || DEFAULT_USERNAME}:${credentials.password}`)}` }
      : undefined
    this.sdk = OpenCode.make({ baseUrl: this.origin, headers })
  }

  /** The raw generated client, for call sites this wrapper does not cover. */
  get api() {
    return this.sdk
  }

  private static location(directory?: string | null) {
    return directory ? { location: { directory } } : undefined
  }

  /**
   * Run one generated-client call under a deadline, forwarding the caller's own
   * signal into it, and normalize whatever fails.
   */
  private async request<T>(
    opts: CallOptions | undefined,
    run: (requestOptions: { signal: AbortSignal }) => Promise<T>,
  ): Promise<T> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    const timer =
      timeoutMs > 0
        ? setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs} ms`)), timeoutMs)
        : undefined
    const caller = opts?.signal
    const forward = () => controller.abort(caller?.reason)
    if (caller) {
      if (caller.aborted) forward()
      else caller.addEventListener("abort", forward, { once: true })
    }
    try {
      return await run({ signal: controller.signal })
    } catch (error) {
      throw toServerError(error)
    } finally {
      if (timer) clearTimeout(timer)
      caller?.removeEventListener("abort", forward)
    }
  }

  /* --------------------------------- server -------------------------------- */

  async info(opts?: CallOptions) {
    return this.request(opts, (requestOptions) => this.sdk.server.info(requestOptions))
  }

  async locationInfo(directory?: string | null, opts?: CallOptions) {
    return this.request(
      opts,
      (requestOptions) =>
        this.sdk.location.get(ServerClient.location(directory), requestOptions) as Promise<LocationPublicInfo>,
    )
  }

  /* ------------------------------ configuration ---------------------------- */

  async agents(directory?: string | null, opts?: CallOptions): Promise<Agent[]> {
    const result = await this.request(opts, (requestOptions) =>
      this.sdk.agent.list(ServerClient.location(directory), requestOptions),
    )
    return result.data
  }

  async models(directory?: string | null, opts?: CallOptions): Promise<Model[]> {
    const result = await this.request(opts, (requestOptions) =>
      this.sdk.model.list(ServerClient.location(directory), requestOptions),
    )
    return result.data
  }

  /** The model the server would pick when a session does not name one. */
  async defaultModel(directory?: string | null, opts?: CallOptions): Promise<Model | null> {
    const result = await this.request(opts, (requestOptions) =>
      this.sdk.model.default(ServerClient.location(directory), requestOptions),
    )
    return result.data
  }

  async providers(directory?: string | null, opts?: CallOptions): Promise<Provider[]> {
    const result = await this.request(opts, (requestOptions) =>
      this.sdk.provider.list(ServerClient.location(directory), requestOptions),
    )
    return result.data
  }

  async configs(directory?: string | null, opts?: CallOptions): Promise<ConfigEntry[]> {
    return this.request(opts, (requestOptions) =>
      this.sdk.config.get(ServerClient.location(directory), requestOptions),
    )
  }

  /**
   * Merge the config documents into the handful of values the app needs.
   * Later entries win, matching the server's own merge order.
   */
  async configValues(directory?: string | null, opts?: CallOptions): Promise<ConfigValues> {
    const entries = await this.configs(directory, opts)
    const values: ConfigValues = {}
    for (const entry of entries) {
      if (entry.type !== "document") continue
      const info = entry.info ?? {}
      const model = info.model
      if (typeof model === "string") values.model = model
      else if (model && typeof model === "object" && "providerID" in model && "model" in model) {
        values.model = `${model.providerID}/${model.model}`
      }
      if (typeof info.default_agent === "string") values.defaultAgent = info.default_agent
      if (typeof info.username === "string") values.username = info.username
    }
    return values
  }

  /** Active provider credentials, keyed by integration id. */
  async connectedIntegrations(): Promise<Set<string>> {
    const connected = new Set<string>()
    try {
      for (const credential of await this.sdk.credential.list()) {
        if (credential.active) connected.add(credential.integrationID)
      }
    } catch {
      /* credentials are optional; the picker then marks nothing as connected */
    }
    return connected
  }

  /** The stored credential value for an integration, when one is active. */
  async credentialKey(integrationID: string): Promise<string | null> {
    try {
      const credentials = await this.sdk.credential.list()
      const credential = credentials.find((item) => item.active && item.integrationID === integrationID)
      const value = credential?.value
      if (value && value.type === "key") return value.key
    } catch {
      /* fall through */
    }
    return null
  }

  async projects(opts?: CallOptions): Promise<Project[]> {
    return this.request(opts, (requestOptions) => this.sdk.project.list(undefined, requestOptions))
  }

  async skills(directory?: string | null, opts?: CallOptions): Promise<SkillInfo[]> {
    const result = await this.request(opts, (requestOptions) =>
      this.sdk.skill.list(ServerClient.location(directory), requestOptions),
    )
    return result.data
  }

  /**
   * The slash commands registered for a location.
   *
   * These are the ones the server can run itself — its own built-ins, the
   * project's `commands/` files and its MCP prompts — and the only names
   * `runCommand` below accepts.
   */
  async commands(directory?: string | null, opts?: CallOptions): Promise<CommandInfo[]> {
    const result = await this.request(opts, (requestOptions) =>
      this.sdk.command.list(ServerClient.location(directory), requestOptions),
    )
    return result.data
  }

  /* ------------------------------ mcp servers ------------------------------ */

  /** The MCP servers of a location, with the connection state of each. */
  async mcpServers(directory?: string | null, opts?: CallOptions): Promise<McpServer[]> {
    const result = await this.request(opts, (requestOptions) =>
      this.sdk.mcp.list(ServerClient.location(directory), requestOptions),
    )
    return result.data
  }

  /** Open a server, which is what a server waiting on a login can never do. */
  async mcpConnect(server: string, directory?: string | null, opts?: CallOptions): Promise<void> {
    await this.request(opts, (requestOptions) =>
      this.sdk.mcp.connect({ server, ...ServerClient.location(directory) }, requestOptions),
    )
  }

  async mcpDisconnect(server: string, directory?: string | null, opts?: CallOptions): Promise<void> {
    await this.request(opts, (requestOptions) =>
      this.sdk.mcp.disconnect({ server, ...ServerClient.location(directory) }, requestOptions),
    )
  }

  /* ------------------------------ integrations ----------------------------- */

  /**
   * An integration and the ways it can be connected.
   *
   * A remote MCP server that wants a login registers one of its own, so this is
   * how the sign-in method for such a server is found.
   */
  async integration(
    integrationID: string,
    directory?: string | null,
    opts?: CallOptions,
  ): Promise<IntegrationInfo> {
    const result = await this.request(opts, (requestOptions) =>
      this.sdk.integration.get({ integrationID, ...ServerClient.location(directory) }, requestOptions),
    )
    return result.data
  }

  /**
   * Begin an OAuth sign-in.
   *
   * The server listens on its own loopback port for the provider's callback, so
   * the returned `url` only has to be opened: the attempt completes without the
   * client's help unless it comes back in `code` mode.
   */
  async oauthConnect(
    integrationID: string,
    methodID: string,
    directory?: string | null,
    opts?: CallOptions,
  ): Promise<IntegrationAttempt> {
    const result = await this.request(opts, (requestOptions) =>
      this.sdk.integration.oauth.connect(
        { integrationID, methodID, ...ServerClient.location(directory) },
        requestOptions,
      ),
    )
    return result.data
  }

  async oauthStatus(integrationID: string, attemptID: string, opts?: CallOptions): Promise<IntegrationAttemptStatus> {
    const result = await this.request(opts, (requestOptions) =>
      this.sdk.integration.oauth.status({ integrationID, attemptID }, requestOptions),
    )
    return result.data
  }

  /** Hand back the code a `code`-mode attempt is waiting on. */
  async oauthComplete(
    integrationID: string,
    attemptID: string,
    code: string | undefined,
    opts?: CallOptions,
  ): Promise<void> {
    await this.request(opts, (requestOptions) =>
      this.sdk.integration.oauth.complete({ integrationID, attemptID, code }, requestOptions),
    )
  }

  /** Give up on an attempt, so the server stops listening for its callback. */
  async oauthCancel(integrationID: string, attemptID: string, opts?: CallOptions): Promise<void> {
    await this.request(opts, (requestOptions) =>
      this.sdk.integration.oauth.cancel({ integrationID, attemptID }, requestOptions),
    )
  }

  /* -------------------------------- sessions -------------------------------- */

  async listSessions(
    directory?: string | null,
    opts: {
      limit?: number
      search?: string
      cursor?: string
    } = {},
    call: CallOptions = {},
  ): Promise<SessionPage> {
    const page = await this.request(call, (requestOptions) =>
      this.sdk.session.list(
        {
          directory: directory ?? undefined,
          limit: opts.limit ?? 50,
          search: opts.search,
          cursor: opts.cursor,
          parentID: "null",
        },
        requestOptions,
      ),
    )
    return { data: page.data, next: page.cursor.next ?? null }
  }

  async createSession(
    body: { title?: string; agent?: string; model?: ModelRef },
    directory?: string | null,
    opts?: CallOptions,
  ): Promise<SessionInfo> {
    return this.request(opts, (requestOptions) =>
      this.sdk.session.create(
        {
          title: body.title,
          agent: body.agent,
          model: body.model ? { id: body.model.id, providerID: body.model.providerID, variant: body.model.variant } : undefined,
          location: directory ? { directory } : undefined,
        },
        requestOptions,
      ),
    )
  }

  async getSession(sessionID: string, opts?: CallOptions): Promise<SessionInfo> {
    return this.request(opts, (requestOptions) => this.sdk.session.get({ sessionID }, requestOptions))
  }

  /**
   * Patch a session. The endpoint answers without a body, so the row is read
   * back: callers need the server's own title to keep the sidebar honest rather
   * than guessing at it.
   */
  async updateSession(
    sessionID: string,
    body: { title?: string },
    opts?: CallOptions,
  ): Promise<SessionInfo> {
    await this.request(opts, (requestOptions) =>
      this.sdk.session.update({ sessionID, title: body.title }, requestOptions),
    )
    return this.getSession(sessionID, opts)
  }

  async removeSession(sessionID: string, opts?: CallOptions): Promise<void> {
    await this.request(opts, (requestOptions) => this.sdk.session.remove({ sessionID }, requestOptions))
  }

  /**
   * Sessions the server is executing right now, keyed by session id.
   *
   * `null` means the question could not be answered, which is different from an
   * empty record: callers fall back to the session's own timestamps rather than
   * reporting "nothing is running".
   */
  async activeSessions(opts?: CallOptions): Promise<Record<string, SessionActive> | null> {
    try {
      return await this.request(opts, (requestOptions) => this.sdk.session.active(requestOptions))
    } catch {
      return null
    }
  }

  /* -------------------------------- messages -------------------------------- */

  async listMessages(
    sessionID: string,
    opts: { limit?: number; cursor?: string; order?: "asc" | "desc" } = {},
    call: CallOptions = {},
  ): Promise<MessagePage> {
    const page = await this.request(call, (requestOptions) =>
      this.sdk.message.list(
        { sessionID, limit: opts.limit ?? 200, cursor: opts.cursor, order: opts.cursor ? undefined : opts.order },
        requestOptions,
      ),
    )
    return { data: page.data, next: page.cursor.next ?? null }
  }

  /**
   * The newest page of a session's messages, oldest first.
   *
   * Asking for `order: desc` and reversing client-side is the only way to ask
   * for "the last N": the cursor is `next`-only, so paging backwards is not
   * possible (see `MessagePage`).
   */
  async recentMessages(sessionID: string, opts: { limit?: number } & CallOptions = {}): Promise<SessionMessageInfo[]> {
    const { limit, ...call } = opts
    const page = await this.listMessages(sessionID, { order: "desc", limit: limit ?? 50 }, call)
    return page.data.slice().reverse()
  }

  /**
   * Every message in a session, oldest first.
   *
   * Paging walks forward from the oldest message with the `next` cursor; the
   * `previous` cursor the server hands out answers with an empty page, so a
   * backward walk silently stops after the first page.
   */
  async allMessages(
    sessionID: string,
    opts: { pageSize?: number; maxPages?: number } & CallOptions = {},
  ): Promise<SessionMessageInfo[]> {
    const { pageSize = 200, maxPages = 200, ...call } = opts
    const messages: SessionMessageInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < maxPages; page++) {
      const current = await this.listMessages(
        sessionID,
        cursor ? { limit: pageSize, cursor } : { limit: pageSize, order: "asc" },
        call,
      )
      messages.push(...current.data)
      if (!current.next || current.data.length === 0) break
      cursor = current.next
    }
    return messages
  }

  /** The model-visible conversation, as the server would send it. */
  async context(sessionID: string, opts?: CallOptions): Promise<SessionMessageInfo[]> {
    return this.request(opts, (requestOptions) => this.sdk.session.context({ sessionID }, requestOptions))
  }

  async prompt(
    sessionID: string,
    body: { text: string; files?: PromptFileInput[]; metadata?: Record<string, string> },
    opts?: CallOptions,
  ): Promise<SessionMessageID> {
    const result = await this.request(opts, (requestOptions) =>
      this.sdk.session.prompt(
        {
          sessionID,
          text: body.text,
          files: body.files?.map((file) => ({ uri: file.uri, name: file.name })),
          // Per-turn admission metadata. The server hands it to plugins, which is
          // how the image tool learns which picture model this client wants.
          metadata: body.metadata,
        },
        requestOptions,
      ),
    )
    return result.id
  }

  async interrupt(sessionID: string, opts?: CallOptions): Promise<void> {
    await this.request(opts, (requestOptions) => this.sdk.session.interrupt({ sessionID }, requestOptions))
  }

  async switchAgent(sessionID: string, agent: string, opts?: CallOptions): Promise<void> {
    await this.request(opts, (requestOptions) => this.sdk.session.switchAgent({ sessionID, agent }, requestOptions))
  }

  async switchModel(sessionID: string, model: ModelRef, opts?: CallOptions): Promise<void> {
    await this.request(opts, (requestOptions) =>
      this.sdk.session.switchModel(
        { sessionID, model: { id: model.id, providerID: model.providerID, variant: model.variant } },
        requestOptions,
      ),
    )
  }

  /**
   * Run a slash command the server knows.
   *
   * The command's own template, agent and model are the server's business: this
   * only hands over the name and the text typed after it, which is what the
   * template's `$ARGUMENTS` and positional placeholders expand.
   */
  async runCommand(
    sessionID: string,
    body: { name: string; text: string; files?: PromptFileInput[]; delivery?: "steer" | "queue" },
    opts?: CallOptions,
  ): Promise<void> {
    await this.request(opts, (requestOptions) =>
      this.sdk.session.command(
        {
          sessionID,
          name: body.name,
          text: body.text,
          files: body.files?.map((file) => ({ uri: file.uri, name: file.name })),
          delivery: body.delivery,
        },
        requestOptions,
      ),
    )
  }

  /** Compact the conversation, as `/compact` does. */
  async compact(sessionID: string, opts?: CallOptions): Promise<void> {
    await this.request(opts, (requestOptions) => this.sdk.session.compact({ sessionID }, requestOptions))
  }

  /* --------------------------- permission and forms -------------------------- */

  async pendingPermissions(directory?: string | null, opts?: CallOptions): Promise<PermissionRequest[]> {
    const result = await this.request(opts, (requestOptions) =>
      this.sdk.permission.request.list(ServerClient.location(directory), requestOptions),
    )
    return result.data
  }

  async replyPermission(
    sessionID: string,
    requestID: string,
    decision: "once" | "always" | "reject",
    opts?: CallOptions,
  ): Promise<void> {
    await this.request(opts, (requestOptions) =>
      this.sdk.permission.reply({ sessionID, requestID, decision }, requestOptions),
    )
  }

  /** Pending forms (the agent's `question` tool) for the whole location. */
  async pendingForms(directory?: string | null, opts?: CallOptions): Promise<FormInfo[]> {
    const result = await this.request(opts, (requestOptions) =>
      this.sdk.form.list(ServerClient.location(directory), requestOptions),
    )
    return result.data
  }

  /** The forms a single session is waiting on. */
  async sessionForms(sessionID: string, opts?: CallOptions): Promise<FormInfo[]> {
    return this.request(opts, (requestOptions) => this.sdk.session.form.list({ sessionID }, requestOptions)).catch(
      () => [] as FormInfo[],
    )
  }

  async replyForm(sessionID: string, formID: string, answer: FormAnswer, opts?: CallOptions): Promise<void> {
    await this.request(opts, (requestOptions) =>
      this.sdk.session.form.reply({ sessionID, formID, answer }, requestOptions),
    )
  }

  async cancelForm(sessionID: string, formID: string, opts?: CallOptions): Promise<void> {
    await this.request(opts, (requestOptions) =>
      this.sdk.session.form.cancel({ sessionID, formID }, requestOptions),
    )
  }

  /* ---------------------------------- events --------------------------------- */

  /**
   * Subscribe to the instance event stream.
   *
   * The generated client already parses SSE frames and yields decoded events;
   * this only translates transport failures. Resolves when the stream ends, and
   * never times out on its own — the caller's signal (and the stream store's
   * liveness watchdog) decide when it is over.
   */
  async subscribe(
    onEvent: (event: V2Event) => void,
    opts: { signal?: AbortSignal; onOpen?: () => void } = {},
  ): Promise<void> {
    let opened = false
    try {
      await this.request({ timeoutMs: 0, signal: opts.signal }, async (requestOptions) => {
        for await (const event of this.sdk.event.subscribe(requestOptions)) {
          if (!opened) {
            opened = true
            opts.onOpen?.()
          }
          onEvent(event)
        }
      })
    } catch (error) {
      if (opts.signal?.aborted) return
      throw toServerError(error)
    }
  }
}
