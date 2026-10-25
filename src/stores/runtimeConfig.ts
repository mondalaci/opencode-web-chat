/**
 * Optional runtime configuration, loaded from `opencode-web-chat.json` served at
 * the site root (i.e. `public/opencode-web-chat.json`, copied into the build).
 *
 * It is a plain static file, so it can be edited on a running deployment and
 * picked up on the next reload — no rebuild or restart needed. A missing or
 * invalid file is treated as an empty config, so the app keeps its defaults.
 *
 * Currently it carries `showProjects`, the pattern list that keeps the picker to
 * a chosen set of projects.
 */
export interface RuntimeConfig {
  /**
   * Projects the picker may show. Each entry matches either the project's folder
   * name (when it has no `/`) or its absolute canonical directory (when it
   * does). `*` matches any run of characters except `/`, and `**` matches any
   * run including `/`.
   *
   * The list is an allowlist: when it is present only the projects it matches
   * appear, and its first entry names the project the app opens by default. An
   * absent or empty list shows every project.
   *
   * Examples:
   *   "scratch"                    the folder named `scratch`, anywhere
   *   "sandbox-*"                  folders named `sandbox-…`
   *   "/home/me/repo"              exactly that project
   *   "/home/me/archive/**"        everything under that directory
   *   "root"                       the root project (canonical "/")
   */
  showProjects?: string[]
}

const CONFIG_URL = `${import.meta.env.BASE_URL}opencode-web-chat.json`

/** Compile one `showProjects` entry: `*` = any run, `**` = any run including `/`. */
function compilePattern(pattern: string): RegExp {
  let source = ""
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*"
        i++
      } else {
        source += "[^/]*"
      }
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }
  }
  return new RegExp(`^${source}$`)
}

/**
 * Whether one pattern matches a project's canonical directory. A pattern with no
 * `/` is matched against the folder name, so it matches that name anywhere; one
 * with a `/` is matched against the whole path.
 */
export function matchesPattern(path: string, pattern: string): boolean {
  if (pattern === "") return false
  // A `/` project has no folder name; the UI calls it "root", so match that.
  const basename = path === "/" ? "root" : (path.split("/").filter(Boolean).pop() ?? path)
  return compilePattern(pattern).test(pattern.includes("/") ? path : basename)
}

/**
 * Whether a project's canonical directory is admitted by the configured
 * patterns. An absent or empty list admits every project — nothing is filtered —
 * while a non-empty one admits only the projects a pattern matches.
 */
export function isProjectShown(path: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns?.length) return true
  return patterns.some((pattern) => matchesPattern(path, pattern))
}

let pending: Promise<RuntimeConfig> | null = null

/** Keep only the settings we understand, so a malformed file cannot break us. */
function normalizeConfig(data: unknown): RuntimeConfig {
  if (!data || typeof data !== "object") return {}
  const raw = (data as { showProjects?: unknown }).showProjects
  if (!Array.isArray(raw)) return {}
  const showProjects = raw.filter((entry): entry is string => typeof entry === "string" && entry !== "")
  return showProjects.length ? { showProjects } : {}
}

/** Fetch the runtime config once; resolves to `{}` when absent or invalid. */
export function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (!pending) {
    pending = fetch(CONFIG_URL, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : {}))
      .catch(() => ({}))
      .then(normalizeConfig)
  }
  return pending
}
