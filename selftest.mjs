#!/usr/bin/env node
/**
 * selftest — avvia server.mjs come farebbe Claude Code, apre una pagina inline
 * e controlla che le cose essenziali funzionino: screenshot vero, console,
 * azioni su un form (anche <select> e checkbox), eval. Non serve rete né un
 * dev server, e non tocca il login salvato.
 *
 *   node selftest.mjs        esce con 0 se tutto funziona
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const page =
  "data:text/html,<title>selftest</title><h1 id=t>ok</h1>" +
  "<select id=s><option value=a>Alfa</option><option value=b>Beta</option></select>" +
  "<input type=checkbox id=c><script>console.error('errore voluto')</script>"

const fail = (msg) => {
  console.error(`selftest FALLITO: ${msg}`)
  process.exit(1)
}

// Config temporanea: niente login salvato, niente URL di default da contattare.
const tmp = mkdtempSync(join(tmpdir(), "web-vision-selftest-"))
const cfgPath = join(tmp, "config.json")
writeFileSync(cfgPath, JSON.stringify({ keepLogin: false, defaultUrl: page }))

const client = new Client({ name: "web-vision-selftest", version: "2.0.0" })
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [join(HERE, "server.mjs")],
    env: { ...process.env, WEB_VISION_CONFIG: cfgPath },
    stderr: "ignore",
  }),
)

try {
  const tools = (await client.listTools()).tools.map((t) => t.name)
  for (const t of ["browser_look", "browser_open", "browser_act", "browser_console", "browser_eval"]) {
    if (!tools.includes(t)) fail(`manca il tool ${t}`)
  }

  const r = await client.callTool({ name: "browser_open", arguments: { url: page } })
  if (r.isError) fail(r.content?.[0]?.text ?? "browser_open ha restituito un errore")
  const img = r.content.find((c) => c.type === "image")
  if (!img || img.data.length < 1000) fail("nessuno screenshot nel risultato")
  const txt = r.content.find((c) => c.type === "text")?.text ?? ""
  if (!txt.includes("errore voluto")) fail("l'errore di console non è stato riportato")

  for (const a of [
    { kind: "select", selector: "#s", text: "Beta" },
    { kind: "check", selector: "#c" },
  ]) {
    const x = await client.callTool({ name: "browser_act", arguments: a })
    if (x.isError) fail(`browser_act ${a.kind}: ${x.content[0].text.split("\n").slice(0, 2).join(" ")}`)
    if (!x.content.some((c) => c.type === "image")) fail(`browser_act ${a.kind} senza screenshot`)
  }

  const ev = await client.callTool({
    name: "browser_eval",
    arguments: { js: "const s = document.getElementById('s').value; [document.getElementById('t').textContent, s, document.getElementById('c').checked]" },
  })
  if (ev.content[0].text.replace(/\s+/g, "") !== '["ok","b",true]') fail(`browser_eval ha letto ${ev.content[0].text}`)

  console.log(
    `selftest ok: 5 tool, screenshot di ${Math.round((img.data.length * 3) / 4 / 1024)} KB, ` +
      "console, select/check ed eval funzionano",
  )
} finally {
  await client.close()
  rmSync(tmp, { recursive: true, force: true })
}
