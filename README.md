# OpenCode Chat

A ChatGPT / claude.ai-style web chat interface for **opencode v2** servers, built
with **Vue 3**, **Vite**, **TypeScript**, and **Reka UI**.

It talks to the server's HTTP API through the official
[`@opencode/client`](https://www.npmjs.com/package/@opencode/client) SDK, so the
wire format is the generated contract that ships with the server version it
targets (see the dependency version in `package.json`).

![OpenCode Chat](docs/screenshots/hero.png)

## Features

- **Instance discovery** — probes local ports for v2 servers (`GET /api/info`),
  then lets you pick one if several are running. Manual address entry and saved
  connections included.
- **Chat UI** — streaming assistant messages, Markdown with syntax highlighting
  (including Mermaid diagrams), reasoning blocks, collapsible tool calls with
  JSON-highlighted inputs/outputs, and inline file/image attachments.
- **Model selection** — applied to the open session through the server's switch
  endpoint, with a per-server remembered default. Every session runs on the
  `build` agent; there is no agent picker.
- **Interactive prompts** — permission requests (allow once / always / deny) and
  agent forms (options, multi-select, yes/no, numbers, free text), with a
  free-form question answerable by typing it straight into the composer. A form
  sends itself the moment its last choice lands; only one that nothing on the
  card can end — a multiple choice, or a step finished in a browser — keeps a
  Submit button.
- **Session management** — new chat, rename, archive (reversibly) with a
  restore/delete view, project switching, live status.
- **Conversation search** — server-side title search with cursor paging, plus
  optional content search through the shared
  [`opencode-search`](https://github.com/mondalaci/opencode-search) service; both
  scoped to the open project.
- **Light / dark theme**, responsive sidebar, keyboard shortcuts.

## Getting started

```bash
bun install      # or: npm install
bun run dev      # http://127.0.0.1:4173
```

Content search is provided by
[`opencode-search`](https://github.com/mondalaci/opencode-search), a sibling
checkout declared as a `file:` dependency (see `src/api/search.ts`). Clone it
next to this repository before installing, or the install step cannot resolve
it:

```bash
git clone https://github.com/mondalaci/opencode-search ../opencode-search
```

Without it running, search falls back to the server's own title search.

Start a server (or use one already running):

```bash
opencode serve --port 4097
```

The UI scans a small set of ports (`4097` first, see `DEFAULT_PORTS` in
`src/api/discovery.ts`). Pick the discovered server in the UI.

Production build:

```bash
bun run build
bun run preview
```

## Authentication

opencode v2 runs as a shared background service and, when started with
`serve --service`, requires HTTP Basic auth: the username is always `opencode`
and the password is the token persisted in `~/.config/opencode/service.json`.

A browser cannot read that file, so the app asks for the password once in the
connect screen and stores it with the saved connection in `localStorage`. The
username is fixed, and the password may be left empty for a server started
without one.

```bash
python3 -c "import json;print(json.load(open('$HOME/.config/opencode/service.json'))['password'])"
```

## Running with PM2

`ecosystem.config.cjs` defines one PM2 app: `opencode-chat`, the **Vite dev
server** on `127.0.0.1:4173`. It runs in dev mode, so it serves `src/` directly
and hot-reloads on every file change — no rebuild needed and the UI is always
current. To serve a static production build instead, run `bun run build` and
switch the app's `args` to `preview --host 127.0.0.1 --port 4173`.

The opencode v2 server is supervised separately, in
`~/.config/opencode/ecosystem.config.cjs`:

```bash
pm2 start ~/.config/opencode/ecosystem.config.cjs   # opencode-server (port 4097)
pm2 start ecosystem.config.cjs                      # opencode-chat  (port 4173)
pm2 save
pm2 startup                                         # optional: relaunch on boot
```

`serve --service` registers the process as the single shared background service,
so the TUI and every other client reuse it; only one supervisor should own it.

If you are upgrading from the previous `kilo-chat`/`kilo-server` setup, replace
the old apps once:

```bash
pm2 delete kilo-chat kilo-server
pm2 start ecosystem.config.cjs
pm2 save
```

To apply config changes (including changed `args`) to a running app:

```bash
pm2 delete opencode-chat && pm2 start ecosystem.config.cjs --only opencode-chat
pm2 save
```

## Configuration

An optional runtime config lives at `public/opencode-web-chat.json` and is
fetched from the site root (`/opencode-web-chat.json`) on load. The real file is
gitignored, so a deployment's settings are never committed; copy the committed
template to create it:

```bash
cp public/opencode-web-chat.example.json public/opencode-web-chat.json
```

It is a plain static file, so you can edit it on a running deployment and the
change applies on the next reload — no rebuild or restart.

The one setting is `showProjects`, the set of projects the sidebar picker may
show. When it is present it is an allowlist — only the projects it matches
appear — and its **first entry names the project the app opens by default**,
unless a `?project=` link or a remembered pick says otherwise. Each entry
matches either a project's folder name (when it has no `/`) or its absolute
canonical directory (when it does); `*` matches any run of characters except `/`,
and `**` matches any run including `/`:

```json
{
  "showProjects": ["chats", "vocab", "/home/me/repo", "/home/me/archive/**"]
}
```

Projects outside the list still exist on the server — they are only omitted from
this app's list, and matching is case-sensitive. An absent or invalid file shows
every project.

A bare folder name can match the same name in more than one place (for example a
checkout under `~/projects` and one under `~/.local/share`), which would list the
project twice and make the default ambiguous. Use an absolute path when exactly
one project should appear.

## URL parameters

The URL can preselect a chat and prefill the composer:

- `?session=<id>` — open an existing chat.
- `?project=<path>` — open that project for one visit, without moving the
  project the app remembers.
- `?query=<text>` — prefill the composer with text.
- `?submit=1` — send the prefilled query immediately, creating a new chat if
  none is open. A bare `?submit` also counts as enabled. After sending, the
  `query`/`submit` params are removed so a reload does not resend.

```text
http://localhost:4173/?project=/home/me/repo&query=Review%20this%20repo&submit=1
```

## How detection works

`src/api/discovery.ts` probes `http://localhost:<port>/api/info` across a small
set of ports (`4097` first, its neighbours, and a few common dev ports) on
`localhost` (loopback aliases such as `127.0.0.1` are canonicalized to
`localhost`). A JSON payload carrying a `version` plus `pid`/`capabilities`
identifies a v2 server, and `GET /api/location` supplies its default project
directory. Saved origins are re-probed on every scan so you can connect to
non-default ports or remote hosts manually.

A server that answers `401` is listed as *password required*. Older Kilo Code /
opencode v1 servers answer `404` on that route and are therefore ignored.

## Project (location) scoping

v2 addresses work by project *location* (`{ "directory": "/abs/path" }`), passed
as the `location` query parameter. The project picker in the sidebar switches
the location; the session list, agents, models, config, permissions and forms
are all scoped to it. Opening a chat that lives in another project switches the
location first.

## CORS / mixed content

The server allows `http://localhost:*` and `http://127.0.0.1:*` origins
automatically, so the Vite dev server can talk to it directly. Any other origin
— including a reverse-proxied host such as `http://chat.localhost` — must be
listed explicitly, or the browser blocks the API calls and discovery reports
"No servers found". For a service-mode server the allowed origins are persisted
in its service config (`opencode service get cors`); the PM2 definition in
`~/.config/opencode/ecosystem.config.cjs` passes them on the command line:

```bash
opencode serve --port 4097 --cors http://chat.localhost
```

Browsers block `http://127.0.0.1` requests from an `https://` page (mixed
content), so serve this UI over `http://` locally.

## Project structure

```
src/
  api/
    client.ts       Thin wrapper over @opencode/client (auth, locations, errors)
    discovery.ts    Port probing and v2 server detection
    types.ts        Re-exported API contract + small app-facing helpers
    search.ts       Binds the shared opencode-search client
  stores/
    connection.ts   Instance list, saved connections, client lifecycle
    server.ts       Agents, models, providers, projects, preferences
    sessions.ts     Session list + mutations (archive is the reversible form)
    chat.ts         Messages, streaming assembly, permissions, forms
    archive.ts      Archived conversations of the open project
    live.ts         Shared SSE subscription with reconnect + resync
    app.ts          Wires the stores together into app-level actions
  components/       UI (Reka UI primitives + custom chat components)
```

## API surface used

| Purpose | Endpoint |
| --- | --- |
| Detection | `GET /api/info`, `GET /api/location` |
| Agents / models / providers | `GET /api/agent`, `GET /api/model`, `GET /api/provider` |
| Config / credentials | `GET /api/config`, `GET /api/credential` |
| Projects | `GET /api/project` |
| Sessions | `GET/POST /api/session`, `GET/PATCH/DELETE /api/session/{id}` |
| Messages | `GET /api/session/{id}/message` |
| Send / interrupt | `POST /api/session/{id}/prompt`, `POST /api/session/{id}/interrupt` |
| Agent / model switch | `POST /api/session/{id}/agent` (the `build` agent), `POST /api/session/{id}/model` |
| Active sessions | `GET /api/session/active` |
| Permissions | `GET /api/permission/request`, `POST /api/session/{id}/permission/{rid}/reply` |
| Forms (agent questions) | `GET /api/form`, `POST /api/session/{id}/form/{fid}/reply` |
| Streaming | `GET /api/event` (SSE) |

## Notes and limitations

- **Streaming** combines the per-block delta events (`session.text.delta`,
  `session.reasoning.delta`, `session.tool.*`) into the message content array,
  then reconciles against the server's own copy at the end of each step, so a
  dropped or out-of-order frame cannot leave the view permanently wrong. The
  reconcile reads the newest page and folds it in, and it settles anything the
  finished turn left looking in flight.
- **Attachments** are sent as `data:` URIs in the prompt's `files` list, which
  the server accepts for files that only exist in the browser. Files echoed back
  on a message are rendered inline (image preview, text preview, download).
- **Public sharing is gone**: v2 has no share endpoint, so the header offers a
  `#` button that copies the current session id instead of creating a public
  URL. Sharing can be configured on the server side (`share` in the config).
- **Tool overrides were dropped**: v2 has no tool-listing endpoint and no
  per-message tool switch — tool availability is expressed as permission rules
  (`permissions` in the config, or per session). The previous sidebar tool
  toggles therefore have no equivalent.
- **Conversations are archived, not deleted**: `DELETE` in v2 removes the row,
  its messages and their parts for good, with nothing to restore. The sidebar
  therefore offers *Archive* (`PATCH` with `archived: true`), and the archive
  view is where a conversation can be restored — or deleted permanently, after
  a confirmation.
- **Stored commands are not surfaced**: the app does not run `/name`
  invocations from the composer. The server's command list is not fetched at
  all; typing `/name` sends it as ordinary text.
- **Image generation** is a server-side plugin's tool (`generate_image`), and
  the composer's image-model pill picks the model that tool runs on. The choice
  travels with each prompt as admission metadata, so it is per turn and never
  changes the conversation's own model. A picture the tool returns is shown
  even while the tool card stays folded, since it is the point of the call.
- The optional content-search service (the
  [`opencode-search`](https://github.com/mondalaci/opencode-search) sibling
  repository, bound in `src/api/search.ts`) indexes a server database
  independently of the opencode HTTP API. When it is not running, search falls
  back to the server's own title search and cursor paging.
