/**
 * browser-vision-hooks — la parte di opencode (v2) del tool web-vision.
 *
 * I tool (`browser_look`, `browser_open`, …) arrivano dal server MCP `web-vision`.
 * Qui resta ciò che un MCP non può fare: il promemoria dopo una modifica
 * (`tool.execute.after`) e l'igiene del contesto (`session.context`).
 *
 * API opencode v2: l'export di default è una definizione `{ id, setup(ctx) }`.
 * Nessun import: `Plugin.define` è l'identità, così il file non dipende dal pacchetto.
 * Il vecchio file v1 è in ../browser-vision-hooks.ts.v1-bak-20261018.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// BROWSER_VISION_HOOKS_CONFIG serve ai test: una prova non deve toccare le sessioni vere.
const CONFIG_PATH = process.env.BROWSER_VISION_HOOKS_CONFIG || join(homedir(), ".config", "opencode", "browser-vision.json")
const LOG_PATH = process.env.BROWSER_VISION_HOOKS_LOG || join(homedir(), ".cache", "browser-vision-hooks", "debug.log")
const LOOK = "web-vision_browser_look"
const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"])

function readConfig(): any {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
  } catch {
    return {}
  }
}

/** Scrive solo se `"debug": true` in browser-vision.json; non rompe mai nulla. */
function debug(cfg: any, what: string, data: unknown) {
  if (!cfg.debug) return
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${what} ${JSON.stringify(data)}\n`)
  } catch {}
}

/** Forma di un valore, senza i contenuti (le immagini sono base64 enormi). */
function shape(v: any, depth = 0): any {
  if (v === null || typeof v !== "object") return typeof v === "string" ? (v.length <= 24 ? v : `str(${v.length})`) : typeof v
  if (depth > 5) return "…"
  if (Array.isArray(v)) return v.slice(0, 4).map((x) => shape(x, depth + 1)).concat(v.length > 4 ? [`+${v.length - 4}`] : [])
  const o: any = {}
  for (const k of Object.keys(v).slice(0, 20)) o[k] = shape(v[k], depth + 1)
  return o
}

export default {
  id: "browser-vision-hooks",
  async setup(ctx: any) {
    await ctx.tool.hook("execute.after", (event: any) => {
      try {
        const cfg = readConfig()
        debug(cfg, "tool.execute.after", { sid: event.sessionID, tool: event.tool, status: event.status, shape: shape(event) })
        if (!EDIT_TOOLS.has(event.tool) || event.status !== "completed") return
        const note = `\n\n[the running page is now stale — call ${LOOK} to see the effect of this change before continuing]`
        const r = event.result
        if (typeof r?.content === "string") r.content += note
        else if (Array.isArray(r?.content)) r.content.push({ type: "text", text: note.trim() })
      } catch {}
    })

    await ctx.session.hook("context", (event: any) => {
      try {
        const cfg = readConfig()
        const keep = typeof cfg.keepRecentImages === "number" ? cfg.keepRecentImages : 2
        const batch = typeof cfg.dropBatch === "number" && cfg.dropBatch > 0 ? cfg.dropBatch : 10
        const msgs = (event.messages ?? []) as any[]
        if (!keep) return

        // Forme misurate (opencode 2.0.32): una parte `file` con `mime: image/*`, o dentro
        // `tool-result.result.value[]` (risultati dei tool, ad es. gli screenshot di web-vision).
        // Le immagini allegate dall'utente sono invece `{ type: "media", media: { mediaType: "image/png", … } }`.
        const isMedia = (p: any) => p?.type === "media" && String(p.media?.mediaType ?? "").startsWith("image/")
        const isImg = (p: any) => (p?.type === "file" && String(p.mime ?? "").startsWith("image/")) || isMedia(p)
        const holds = (m: any) =>
          (m.content ?? []).some(
            (p: any) =>
              isImg(p) || (p?.type === "tool-result" && Array.isArray(p.result?.value) && p.result.value.some(isImg)),
          )
        const NOTE_USER = "[an image attached earlier was dropped from the history to save context — ask the user to attach it again if you need it]"
        const NOTE = `[screenshot dropped from the history to save context — call ${LOOK} again if you need to see it]`

        // Si tolgono a blocchi di `batch`: la storia cambia una volta ogni `batch` screenshot,
        // non a ogni richiesta, così la cache del prompt nel server resta valida.
        const holders = msgs.filter(holds)
        const cutoff = Math.max(0, Math.floor((holders.length - keep) / batch) * batch)
        let dropped = 0
        for (const m of holders.slice(0, cutoff)) {
          m.content = m.content.map((p: any) => {
            if (isImg(p)) { dropped++; return { type: "text", text: isMedia(p) ? NOTE_USER : NOTE } }
            if (p?.type === "tool-result" && Array.isArray(p.result?.value)) {
              const value = p.result.value.map((v: any) => (isImg(v) ? (dropped++, { type: "text", text: NOTE }) : v))
              return { ...p, result: { ...p.result, value } }
            }
            return p
          })
        }
        debug(cfg, "session.context", {
          sid: event.sessionID, n: msgs.length, holders: holders.length, keep, batch, dropped,
          ...(cfg.debug ? { nonText: msgs.filter((m) => m.role === "user" && (m.content ?? []).some((p: any) => p?.type !== "text")).slice(0, 1).map((m) => shape(m)) } : {}),
        })
      } catch {}
    })
  },
}
