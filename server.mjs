#!/usr/bin/env node
/**
 * web-vision — server MCP per Claude Code che fa VEDERE e USARE al modello un
 * frontend vero: locale, in rete locale o pubblicato, HTTP o HTTPS.
 *
 * Non usa estensioni né il Chrome dell'utente: avvia un Chromium suo, isolato.
 * Ogni azione restituisce uno screenshot e un resoconto VERITIERO di cosa è
 * successo nella pagina (errori, richieste, dialog, nuove schede). Un resoconto
 * falso — "nessun errore" quando c'è, "richiesta fallita" quando è riuscita —
 * è peggio di nessun resoconto, perché il modello ci crede: ogni scelta qui
 * sotto parte da lì.
 *
 * Il risultato di un tool è testo; le immagini arrivano al modello solo come
 * contenuto MCP di tipo "image".
 *
 * stdout è il canale del protocollo MCP: qualsiasi log va su stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { chromium } from "playwright-core"
import { z } from "zod"
import * as acorn from "acorn"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { connect } from "node:net"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = process.env.WEB_VISION_CONFIG || join(HERE, "config.json")

/**
 * Flag di Chromium per sistema operativo. Su Linux headless di solito non c'è
 * una GPU utilizzabile: WebGL/WebGL2 passano da SwiftShader (CPU). Misurato su
 * una pagina animata: `--use-angle=swiftshader` porta TUTTO il rendering su
 * SwiftShader e consuma ~300% di CPU; `swiftshader-webgl` lo usa solo per
 * WebGL, con lo stesso renderer e ~40%. Su macOS il Chromium headless usa
 * Metal da solo: forzare SwiftShader lì è inutile e più lento.
 */
function defaultLaunchArgs() {
  if (process.platform === "darwin") return ["--hide-scrollbars"]
  return [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-angle=swiftshader-webgl",
    "--enable-unsafe-swiftshader",
    "--hide-scrollbars",
  ]
}

const DEFAULTS = {
  defaultUrl: "http://127.0.0.1:5173",
  autoStart: false,
  idleCloseMinutes: 10,
  viewport: { width: 1280, height: 720 },
  jpegQuality: 75,
  // Certificati autofirmati o di una CA interna: i frontend di sviluppo e di
  // staging li usano quasi sempre, e senza questo non si aprono affatto.
  ignoreHTTPSErrors: true,
  // Cookie e localStorage sopravvivono fra le sessioni e alla chiusura per
  // inattività: un frontend con login non richiede di rifarlo ogni volta.
  keepLogin: true,
  storageStatePath: join(homedir(), ".cache", "web-vision", "storage-state.json"),
  // alert/confirm/prompt: "accept" o "dismiss". Vengono sempre riportati.
  dialogs: "accept",
  httpCredentials: null,
  extraHTTPHeaders: null,
  extraHTTPHeadersHosts: null,
  actionTimeoutMs: 5000,
  navigationTimeoutMs: 45000,
  evalTimeoutMs: 30000,
  // Oltre questa altezza full_page cattura solo la parte alta: un'immagine più
  // alta arriva al modello rimpicciolita fino a essere illeggibile, e oltre
  // ~65000 px Chromium restituisce un'immagine vuota.
  maxFullPageHeight: 3000,
  executablePath: undefined,
  launchArgs: defaultLaunchArgs(),
}

function log(...a) {
  console.error("[web-vision]", ...a)
}

function loadConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS }
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
    return { ...DEFAULTS, ...raw, viewport: { ...DEFAULTS.viewport, ...(raw.viewport ?? {}) } }
  } catch (e) {
    log(`config illeggibile (${CONFIG_PATH}): ${e?.message ?? e} — uso i default`)
    return { ...DEFAULTS }
  }
}

const cfg = loadConfig()

/** I messaggi di Playwright contengono codici colore ANSI: illeggibili per il modello. */
const clean = (m) => String(m ?? "").replace(/\x1b\[[0-9;]*m/g, "")

/**
 * Una pagina con JavaScript che non termina (un `while(true){}`) blocca il
 * thread della pagina: ogni evaluate resta appeso per sempre e con lui il
 * server. Ogni attesa sulla pagina passa da qui, con un limite; se scade la
 * pagina è considerata congelata e Chromium viene riavviato.
 */
class FrozenPage extends Error {
  constructor(what) {
    super(`the page stopped responding while ${what}`)
    this.frozen = true
  }
}
function guard(promise, ms, what) {
  let t
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new FrozenPage(what)), ms)
      t.unref()
    }),
  ]).finally(() => clearTimeout(t))
}
/**
 * `page.goto` aspetta fino a `navigationTimeoutMs` (45 s) e una pagina il cui
 * JavaScript si blocca mentre si carica (un ciclo infinito in un `<script>`)
 * resta lì per tutto quel tempo. Qui si chiede alla pagina se risponde ancora,
 * ma solo quando ha senso:
 *
 * - la risposta del documento è ARRIVATA (segnale del processo browser, che
 *   arriva anche con il renderer bloccato): prima il silenzio è normale, è il
 *   server che è lento, e un backend che risponde in 30 s non deve sembrare
 *   una pagina congelata (misurato: senza questo controllo, un server lento
 *   veniva dichiarato "congelato");
 * - il frame ha lasciato l'URL di partenza, cioè il documento è committato:
 *   con un 302 verso un server lento la risposta era arrivata ma la pagina
 *   nuova non esisteva ancora (misurato: falso «congelata» in 7 s).
 */
async function goWithLiveness(nav, page, target) {
  const start = page.url()
  // Ricaricando la stessa URL l'indirizzo non cambia al commit: lì basta che la
  // risposta sia arrivata.
  const mustMove = href(target) !== href(start)
  let arrived = false
  const onResponse = (r) => {
    if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) arrived = true
  }
  page.on("response", onResponse)
  let done = false
  nav.then(() => (done = true), () => (done = true))
  let mute = 0
  try {
    while (!done) {
      await sleep(1500)
      if (done) break
      if (!arrived) {
        mute = 0
        continue
      }
      if (mustMove) {
        let cur = start
        try {
          cur = page.url()
        } catch {
          /* scheda chiusa */
        }
        if (cur === start) {
          mute = 0
          continue
        }
      }
      const alive = await Promise.race([
        page.evaluate(() => 1).then(
          () => true,
          () => true, // un errore (contesto distrutto dal caricamento) = la pagina risponde
        ),
        sleep(2000).then(() => false),
      ])
      if (alive) {
        mute = 0
        continue
      }
      if (++mute >= 2) {
        nav.catch(() => {}) // il goto resta in volo: la sua fine non deve esplodere da sola
        throw new FrozenPage("loading (the document arrived but the page never answered)")
      }
    }
    return await nav
  } finally {
    page.off("response", onResponse)
  }
}

const sleep = (ms) =>
  new Promise((r) => {
    const t = setTimeout(r, ms)
    t.unref()
  })

// Claude Code avvia i server stdio nella cartella del progetto: è lì che
// autoStart cerca il package.json con lo script dev.
const PROJECT_DIR = process.env.WEB_VISION_PROJECT_DIR || process.cwd()
const MAX_LOG = 1000

/** Trova un Chromium già installato, così non serve scaricare niente. */
function findChromium() {
  if (cfg.executablePath && existsSync(cfg.executablePath)) return cfg.executablePath
  try {
    const expected = chromium.executablePath()
    if (expected && existsSync(expected)) return expected
  } catch {
    /* non installato: si cerca altrove */
  }
  const rels = [
    ["chrome-linux64", "chrome"],
    ["chrome-linux", "chrome"],
    ["chrome-headless-shell-linux64", "chrome-headless-shell"],
    ["chrome-mac", "Chromium.app/Contents/MacOS/Chromium"],
    ["chrome-mac-arm64", "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"],
    ["chrome-mac-x64", "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"],
  ]
  const roots = [
    [process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium", 2_000_000],
    [join(homedir(), ".cache", "ms-playwright"), "chromium", 1_000_000],
    [join(homedir(), "Library", "Caches", "ms-playwright"), "chromium", 1_000_000],
    [join(homedir(), ".cache", "puppeteer", "chrome"), "linux-", 0],
  ]
  const found = []
  for (const [root, prefix, base] of roots) {
    if (!root) continue
    let entries
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue
      const rev = Number(/(\d+)/.exec(entry)?.[1]) || 0
      for (const [dir, bin] of rels) {
        const candidate = join(root, entry, dir, bin)
        if (existsSync(candidate)) {
          found.push({ path: candidate, rank: base + rev * 10 + (bin.includes("headless") ? 0 : 1) })
        }
      }
    }
  }
  found.sort((a, b) => b.rank - a.rank)
  return found[0]?.path
}

// --------------------------------------------------------------------------
// sessione: un browser, un contesto, la scheda attiva
// --------------------------------------------------------------------------

let session = null
let launching = null
let navLock = Promise.resolve()
let idleTimer = null
let saveTimer = null
// L'ultima pagina aperta con successo. Sopravvive alla chiusura per inattività:
// quando Chromium riparte, si torna lì invece che all'URL di default.
let lastUrl = null
// Chiamate in corso: la chiusura per inattività non deve scattare durante una
// chiamata lunga (visto: "Target page closed" a metà di un wait_ms).
let busy = 0

const startUrl = () => lastUrl ?? cfg.defaultUrl

function touch() {
  if (idleTimer) clearTimeout(idleTimer)
  const minutes = Number(cfg.idleCloseMinutes) || 0
  if (minutes <= 0) return
  idleTimer = setTimeout(async () => {
    if (!session) return
    if (busy > 0) return touch()
    log(`nessuna chiamata da ${minutes} min: chiudo Chromium`)
    const s = session
    session = null
    await saveState(s)
    s.browser.close().catch(() => {})
  }, minutes * 60_000)
  idleTimer.unref()
}

// ---- login salvato (cookie, localStorage, IndexedDB) ------------------------
//
// Più sessioni di Claude Code possono usare lo stesso file insieme. Scrivere
// "il mio stato" sopra il file faceva vincere l'ultima che salvava: una
// sessione non loggata cancellava il login appena fatto da un'altra (provato).
// Quindi si fa un'unione a tre vie: rispetto allo stato caricato o salvato per
// ultimo ("base"), si scrive solo ciò che QUESTA sessione ha cambiato, e tutto
// il resto si prende dal file com'è adesso. La scrittura è atomica (file
// temporaneo + rename) e nasce con permessi 0600: contiene cookie di sessione.

const EMPTY_STATE = { cookies: [], origins: [] }

function readStateFile() {
  try {
    const st = JSON.parse(readFileSync(cfg.storageStatePath, "utf8"))
    return { cookies: st.cookies ?? [], origins: st.origins ?? [] }
  } catch {
    return null
  }
}

const cookieKey = (c) => `${c.name}\u0000${c.domain}\u0000${c.path}`
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function mergeStates(base, ours, theirs) {
  // cookie
  const bC = new Map(base.cookies.map((c) => [cookieKey(c), c]))
  const oC = new Map(ours.cookies.map((c) => [cookieKey(c), c]))
  const out = new Map(theirs.cookies.map((c) => [cookieKey(c), c]))
  for (const k of new Set([...bC.keys(), ...oC.keys()])) {
    if (same(bC.get(k), oC.get(k))) continue // non toccato da noi: vale il file
    if (oC.has(k)) out.set(k, oC.get(k))
    else out.delete(k) // cancellato da noi (es. logout)
  }
  // origini: localStorage chiave per chiave, IndexedDB per origine
  const byOrigin = (st) => new Map(st.origins.map((o) => [o.origin, o]))
  const bO = byOrigin(base)
  const oO = byOrigin(ours)
  const tO = byOrigin(theirs)
  const origins = []
  for (const origin of new Set([...tO.keys(), ...oO.keys(), ...bO.keys()])) {
    const b = bO.get(origin)
    const o = oO.get(origin)
    const t = tO.get(origin)
    const ls = new Map((t?.localStorage ?? []).map((e) => [e.name, e.value]))
    const bL = new Map((b?.localStorage ?? []).map((e) => [e.name, e.value]))
    const oL = new Map((o?.localStorage ?? []).map((e) => [e.name, e.value]))
    for (const k of new Set([...bL.keys(), ...oL.keys()])) {
      if (bL.get(k) === oL.get(k)) continue
      if (oL.has(k)) ls.set(k, oL.get(k))
      else ls.delete(k)
    }
    const idb = same(b?.indexedDB, o?.indexedDB) ? t?.indexedDB : o?.indexedDB
    if (!ls.size && !(idb && idb.length)) continue
    const entry = { origin, localStorage: [...ls].map(([name, value]) => ({ name, value })) }
    if (idb && idb.length) entry.indexedDB = idb
    origins.push(entry)
  }
  return { cookies: [...out.values()], origins }
}

async function saveState(s) {
  if (!cfg.keepLogin || !s) return
  try {
    const ours = await guard(s.context.storageState({ indexedDB: true }), 5000, "reading cookies")
    if (same(ours, s.stateBase)) return // niente di nuovo da questa sessione
    const theirs = readStateFile() ?? EMPTY_STATE
    const merged = mergeStates(s.stateBase ?? EMPTY_STATE, ours, theirs)
    s.stateBase = ours
    if (same(merged, theirs)) return
    mkdirSync(dirname(cfg.storageStatePath), { recursive: true, mode: 0o700 })
    const tmp = `${cfg.storageStatePath}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(merged), { mode: 0o600 })
    renameSync(tmp, cfg.storageStatePath)
  } catch (e) {
    log(`impossibile salvare il login: ${e?.message ?? e}`)
  }
}

function scheduleSave(s) {
  if (!cfg.keepLogin || !s) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void saveState(s), 1000)
  saveTimer.unref()
}

function loadState() {
  if (!cfg.keepLogin || !existsSync(cfg.storageStatePath)) return undefined
  const st = readStateFile()
  if (!st) log("login salvato illeggibile: si parte senza")
  return st ?? undefined
}

/** Sostituisce %s %d %o… come farebbe DevTools, invece di lasciarli nel testo. */
async function formatConsole(m) {
  const args = m.args()
  if (!args.length) return m.text()
  // Un Error passato a console (come fa React con un error boundary) non
  // sopravvive a jsonValue: diventerebbe {"name":"TypeError"}, senza messaggio
  // né stack. Se ne prende lo stack nella pagina.
  const vals = await Promise.all(
    args.map(async (a) => {
      const err = await a.evaluate((v) => (v instanceof Error ? v.stack || `${v.name}: ${v.message}` : null)).catch(() => null)
      if (err) return err
      return a.jsonValue().then(
        (v) => (typeof v === "string" ? v : JSON.stringify(v)),
        () => a.toString(),
      )
    }),
  )
  const [first, ...rest] = vals
  if (typeof first !== "string" || !/%[sdioOcfj%]/.test(first)) return vals.join(" ")
  let i = 0
  // Un solo passaggio: "%%" diventa "%" solo nel formato, mai dentro i valori
  // sostituiti ("%s" con "a%%b" resta "a%%b", come in DevTools).
  const head = first.replace(/%[sdioOcfj%]/g, (t) => {
    if (t === "%%") return "%"
    const v = rest[i++]
    return t === "%c" ? "" : (v ?? t)
  })
  return [head, ...rest.slice(i)].join(" ").trim()
}

function attachPage(s, page) {
  const push = (e) => {
    const entry = { ...e, at: Date.now() }
    s.log.push(entry)
    // Tagliare la testa del buffer senza spostare i cursori li lascerebbe
    // oltre la fine: da lì in poi ogni sguardo direbbe "nessun errore".
    const drop = s.log.length - MAX_LOG
    if (drop > 0) {
      s.log.splice(0, drop)
      s.lookCursor = Math.max(0, s.lookCursor - drop)
      for (const k of Object.keys(s.consoleCursor)) s.consoleCursor[k] = Math.max(0, s.consoleCursor[k] - drop)
      s.dropped = (s.dropped ?? 0) + drop
    }
    return entry
  }

  page.on("console", (m) => {
    const type = m.type()
    const entry = push({ kind: "console", level: type, text: `${type}: ${m.text()}` })
    // Il testo vero (con i %s sostituiti) arriva un attimo dopo: si aggiorna la
    // voce già inserita, così l'ordine resta quello degli eventi.
    formatConsole(m)
      .then((t) => {
        entry.text = `${type}: ${t}`
      })
      .catch(() => {})
  })
  page.on("pageerror", (e) => {
    const stack = (e.stack || e.message || String(e)).split("\n").slice(0, 6).join("\n    ")
    push({ kind: "error", text: stack })
  })
  // Richieste in volo, per sapere quando la rete è tranquilla. Una fetch di cui
  // la pagina non legge mai il corpo non emette né requestfinished né
  // requestfailed: contata come "in volo" per sempre, rallentava di 2 s ogni
  // azione successiva. Per fetch/XHR conta quindi la RISPOSTA (lì il server ha
  // già risposto), e comunque una richiesta più vecchia di 5 s non trattiene.
  page.on("request", (r) => {
    if (r.resourceType() === "websocket") return
    // Contatore delle navigazioni del documento principale: serve a riconoscere
    // il secondo annuncio della STESSA navigazione fallita (vedi requestfailed).
    if (r.isNavigationRequest()) {
      try {
        if (r.frame() === page.mainFrame()) s.navSeq = (s.navSeq ?? 0) + 1
      } catch {
        /* fotogramma staccato */
      }
    }
    s.pending.set(r, Date.now())
    s.lastActivity = Date.now()
  })
  const done = (r) => {
    s.pending.delete(r)
    s.lastActivity = Date.now()
  }
  page.on("requestfinished", (r) => done(r))
  page.on("requestfailed", (r) => {
    if (r.resourceType() === "websocket") return
    const answered = s.answered.has(r)
    done(r)
    const err = r.failure()?.errorText ?? "failed"
    // ERR_ABORTED non è un fallimento della rete: è il browser che smette di
    // leggere (una fetch "spara e dimentica", una navigazione che cancella le
    // richieste in corso). Se il server aveva già risposto, la richiesta è
    // RIUSCITA ed è già nel log con il suo stato: non si aggiunge altro. Visto
    // un modello dedurre "dati persi sul server" dalla sola parola "aborted".
    if (/ERR_ABORTED/.test(err)) {
      const rt = r.resourceType()
      if (!answered && (rt === "fetch" || rt === "xhr")) {
        push({ kind: "net", method: r.method(), text: `${r.method()} ${r.url()} — cancelled before any response (no server error)` })
      }
      return
    }
    // La stessa navigazione fallita viene annunciata DUE volte. Misurato: la
    // seconda non è una richiesta nuova della pagina, è il browser che prova a
    // mostrare la propria pagina d'errore — il fotogramma della seconda è
    // `chrome-error://chromewebdata/`, quello della prima è ancora il documento
    // vero, e la seconda è la navigazione immediatamente successiva (nessun'altra
    // navigazione in mezzo). Si tiene solo la prima: la seconda non è un guasto
    // nuovo, e arriva ~1 s dopo, spesso quando l'occhio è già passato oltre (lo
    // stesso guasto si vedrebbe in due sguardi diversi). Un secondo tentativo
    // vero parte da una navigazione nuova (la nostra, o della pagina): il
    // contatore non torna e si vede. Le due condizioni vanno **entrambe**:
    // nascondere un guasto vero sarebbe peggio che mostrarne uno in più.
    const topNav = (() => {
      try {
        return r.isNavigationRequest() && r.frame() === page.mainFrame()
      } catch {
        return false
      }
    })()
    const url = r.url()
    const onErrorPage = (() => {
      try {
        return /^chrome-error:/.test(r.frame()?.url() ?? "")
      } catch {
        return false // fotogramma staccato: meglio mostrare il guasto che tacerlo
      }
    })()
    if (
      topNav &&
      onErrorPage &&
      s.lastTopNavFail &&
      s.lastTopNavFail.url === url &&
      s.lastTopNavFail.err === err &&
      (s.navSeq ?? 0) === s.lastTopNavFail.seq + 1 &&
      // Nessuna navigazione ordinata da noi dopo quel guasto: se il modello ha
      // riprovato davvero, il guasto nuovo non va nascosto.
      (s.lastToolNavAt ?? 0) <= s.lastTopNavFail.at
    ) {
      return
    }
    if (topNav) s.lastTopNavFail = { url, err, seq: s.navSeq ?? 0, at: Date.now() }
    push({ kind: "failed", method: r.method(), text: `${r.method()} ${url} — ${err}` })
  })
  page.on("response", (r) => {
    const req = r.request()
    const t = req.resourceType()
    s.answered.add(req)
    if (r.status() >= 400) push({ kind: "http", method: req.method(), text: `${r.status()} ${req.method()} ${r.url()}` })
    else if (t === "fetch" || t === "xhr") push({ kind: "net", method: req.method(), text: `${req.method()} ${r.status()} ${r.url()}` })
    if (t === "fetch" || t === "xhr") done(req)
  })
  page.on("dialog", (d) => {
    const action = cfg.dialogs === "dismiss" ? "dismissed" : "accepted"
    push({ kind: "dialog", text: `${d.type()} "${d.message()}" → ${action} automatically` })
    ;(cfg.dialogs === "dismiss" ? d.dismiss() : d.accept()).catch(() => {})
  })
  page.on("close", () => {
    if (s.page !== page) return
    const others = s.context.pages().filter((p) => p !== page)
    if (others.length) {
      s.page = others[others.length - 1]
      push({ kind: "tab", text: `tab closed — now showing ${s.page.url()}` })
    }
  })
}

async function launch() {
  const executablePath = findChromium()
  if (!executablePath) {
    throw new Error(
      "No Chromium found. Install it with: " +
        `node ${join(HERE, "node_modules", "playwright-core", "cli.js")} install chromium`,
    )
  }
  // I segnali li gestisce shutdown(): prima si salva il login, poi si chiude.
  // Con i gestori di Playwright Chromium veniva ucciso prima del salvataggio
  // ("browser has been closed"). Chromium muore comunque con il nostro
  // processo, perché la pipe CDP si chiude (provato anche con kill -9).
  const browser = await chromium.launch({
    executablePath,
    args: cfg.launchArgs,
    chromiumSandbox: false,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  })
  const loaded = loadState()
  const hdrHosts =
    Array.isArray(cfg.extraHTTPHeadersHosts) && cfg.extraHTTPHeadersHosts.length ? cfg.extraHTTPHeadersHosts : null
  const context = await browser.newContext({
    viewport: cfg.viewport,
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: !!cfg.ignoreHTTPSErrors,
    // Service worker bloccati: un'app PWA servirebbe dalla propria cache i
    // file di prima della modifica, e nessun reload lo impedirebbe.
    serviceWorkers: "block",
    storageState: loaded,
    httpCredentials: cfg.httpCredentials ?? undefined,
    // Header extra a TUTTI i siti, salvo che extraHTTPHeadersHosts li limiti:
    // allora li aggiunge il routing, solo per quei nomi host.
    extraHTTPHeaders: hdrHosts ? undefined : (cfg.extraHTTPHeaders ?? undefined),
  })
  // Cache HTTP spenta. Senza, un server che manda `Cache-Control: max-age`
  // sugli asset fa vedere HTML nuovo con CSS e JS VECCHI anche dopo un reload
  // (provato). `Network.setCacheDisabled` via CDP non basta: Playwright
  // gestisce la rete da sé e lo scavalca. Attivare il routing invece disattiva
  // davvero la cache, ed è il modo documentato. I websocket (HMR) non passano
  // dal routing.
  await context.route("**/*", (route) => {
    if (hdrHosts && cfg.extraHTTPHeaders) {
      try {
        const req = route.request()
        if (hdrHosts.includes(new URL(req.url()).hostname)) {
          return route.continue({ headers: { ...req.headers(), ...cfg.extraHTTPHeaders } })
        }
      } catch {
        /* URL non analizzabile: niente header */
      }
    }
    return route.continue()
  })

  const s = {
    browser,
    context,
    stateBase: loaded ?? EMPTY_STATE,
    page: null,
    log: [],
    lookCursor: 0,
    // Un cursore per filtro: leggere solo i problemi non deve far perdere i log.
    consoleCursor: { all: 0, problems: 0, console: 0, network: 0 },
    pending: new Map(),
    answered: new WeakSet(),
    lastActivity: Date.now(),
    navigated: false,
  }
  s.page = await context.newPage()
  attachPage(s, s.page)
  // Una nuova scheda (target=_blank, window.open) diventa quella attiva:
  // altrimenti il modello guarderebbe la vecchia credendo di vedere la nuova.
  context.on("page", (p) => {
    attachPage(s, p)
    s.page = p
    // Una pagina che apre popup a raffica non deve riempire la memoria: oltre
    // 10 schede si chiudono le più vecchie (mai la prima).
    const all = context.pages()
    for (const old of all.slice(1, Math.max(1, all.length - 9))) {
      if (old !== p) old.close({ runBeforeUnload: false }).catch(() => {})
    }
    s.log.push({ kind: "tab", text: `a new tab was opened by the page — now showing it (${p.url() || "loading"})`, at: Date.now() })
  })
  browser.on("disconnected", () => {
    if (session === s) session = null
  })
  log(`Chromium avviato: ${executablePath}`)
  return s
}

async function ensureSession() {
  touch()
  if (session && !session.browser.isConnected()) session = null
  if (session) {
    // Una scheda chiusa (window.close() di un popup, tipico del login OAuth)
    // non è una pagina bloccata: si torna a un'altra scheda aperta. Solo se
    // non ne resta nessuna si riparte da capo.
    const pickOpen = () => {
      const open = session.context.pages().filter((p) => !p.isClosed())
      if (open.length) session.page = open[open.length - 1]
      return open.length > 0
    }
    if (session.page.isClosed() && !pickOpen()) session = null
  }
  if (session) {
    // Controllo di salute: se la pagina non risponde più (congelata da una
    // chiamata precedente), si riparte invece di restare appesi.
    try {
      await guard(session.page.evaluate("1"), 3000, "checking that it is alive")
    } catch (e) {
      const closing = !e?.frozen || session.page.isClosed()
      if (closing) {
        // La scheda si stava chiudendo proprio adesso.
        await new Promise((r) => setTimeout(r, 300))
        const open = session.context.pages().filter((p) => !p.isClosed())
        if (open.length) session.page = open[open.length - 1]
        else await recover("no tab left")
      } else {
        await recover("the page was not responding")
      }
    }
  }
  if (session) return session
  if (!launching) {
    launching = launch()
      .then((s) => (session = s))
      .finally(() => (launching = null))
  }
  return launching
}

/**
 * Chiude un Chromium bloccato e lascia che la prossima chiamata ne apra uno
 * nuovo. Se è la STESSA pagina a congelarsi due volte di fila (per esempio si
 * blocca da sola poco dopo il caricamento), non la si riapre più: si riparte
 * dall'URL di default invece di riprodurre il blocco a ogni chiamata.
 */
let lastFrozenUrl = null
// Detto al modello nella risposta successiva: un riavvio silenzioso gli farebbe
// credere che la pagina abbia ancora lo stato di prima.
let restartNote = null
async function recover(reason) {
  const s = session
  session = null
  if (!s) return
  const url = s.page && !s.page.isClosed() ? s.page.url() : null
  if (url && lastFrozenUrl && href(url) === href(lastFrozenUrl)) {
    if (lastUrl && href(lastUrl) === href(url)) lastUrl = null
  }
  lastFrozenUrl = url
  restartNote = `Chromium was restarted (${reason}): page state from before (filled fields, clicks, scroll) is gone.`
  log(`riavvio Chromium: ${reason}`)
  await guard(s.browser.close(), 5000, "closing").catch(() => {})
}

function portOpen(host, port, timeoutMs = 800) {
  return new Promise((res) => {
    const sock = connect({ host, port })
    const end = (ok) => {
      sock.destroy()
      res(ok)
    }
    sock.setTimeout(timeoutMs, () => end(false))
    sock.once("connect", () => end(true))
    sock.once("error", () => end(false))
  })
}

function isLocal(u) {
  try {
    const h = new URL(u).hostname
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]"
  } catch {
    return false
  }
}

/** Avvia il dev server del progetto (autoStart) e aspetta che la porta risponda. */
async function startDevServer(url) {
  const pkgPath = join(PROJECT_DIR, "package.json")
  if (!existsSync(pkgPath)) return { ok: false, note: `autoStart: ${PROJECT_DIR} has no package.json` }
  let scripts = {}
  try {
    scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {}
  } catch {
    return { ok: false, note: `autoStart: ${pkgPath} is unreadable` }
  }
  const script = ["dev", "start", "serve"].find((k) => scripts[k])
  if (!script) return { ok: false, note: `autoStart: ${PROJECT_DIR} has no dev/start/serve script` }

  const child = spawn("npm", ["run", script], { cwd: PROJECT_DIR, detached: true, stdio: "ignore" })
  child.unref()
  const u = new URL(url)
  const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80)
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (await portOpen(u.hostname.replace(/^\[|\]$/g, ""), port)) {
      return { ok: true, note: `started \`npm run ${script}\` in ${PROJECT_DIR}` }
    }
  }
  return { ok: false, note: `autoStart: ran \`npm run ${script}\` in ${PROJECT_DIR} but port ${port} never opened` }
}

/**
 * Prepara il codice di browser_eval in Node, con un parser vero, così nella
 * pagina viene eseguito UNA volta sola come corpo di una funzione async:
 * - un'espressione (anche con await, anche `{a: 1}`) → `return (espressione)`;
 * - istruzioni → se l'ultima è un'espressione, diventa il valore restituito
 *   (`const r = await fetch("/"); r.status` → lo stato).
 * Un errore di sintassi viene riportato senza eseguire nulla.
 */
function prepareEval(src) {
  const opts = { ecmaVersion: "latest", sourceType: "script", allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }
  try {
    const expr = acorn.parseExpressionAt(src, 0, opts)
    if (src.slice(expr.end).trim().replace(/;$/, "").trim() === "") return { body: `return (${src.slice(0, expr.end)}\n)` }
  } catch {
    /* non è una sola espressione */
  }
  let ast
  try {
    ast = acorn.parse(src, opts)
  } catch (e) {
    return { error: `SyntaxError in the code: ${e.message}. Nothing was executed.` }
  }
  const last = ast.body[ast.body.length - 1]
  // Senza await né return, l'eval indiretto restituisce il "valore di
  // completamento" anche di un if o di un blocco (`if (x) { 5 } else { 6 }`).
  if (last && last.type !== "ExpressionStatement" && !/\bawait\b|\breturn\b/.test(src)) return { indirect: src }
  if (last && last.type === "ExpressionStatement") {
    const exprSrc = src.slice(last.expression.start, last.expression.end)
    return { body: `${src.slice(0, last.start)}return (${exprSrc}\n);${src.slice(last.end)}` }
  }
  return { body: src }
}

/** Traduce l'errore di rete di Chromium in qualcosa su cui il modello può agire. */
function explainNavError(raw, url) {
  const msg = clean(raw).split("\n")[0].replace(/^page\.goto:\s*/, "")
  const hints = [
    [/ERR_CONNECTION_REFUSED/, "Nothing is listening at that address: the server is not running, the port is wrong, or (for a dev server on another machine) it was started without exposing it to the network — e.g. Vite needs `--host`."],
    [/ERR_NAME_NOT_RESOLVED/, "The host name cannot be resolved from this machine (typo, or a name that only exists on another network/VPN)."],
    [/ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|Timeout .* exceeded/, "The server did not answer in time: unreachable host, a firewall, or a very slow page."],
    [/ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_UNREACHABLE/, "That network address is not reachable from this machine."],
    [/ERR_INVALID_AUTH_CREDENTIALS|ERR_UNEXPECTED_PROXY_AUTH/, `The site asks for HTTP authentication (Basic/Digest login popup). Put the credentials in "httpCredentials" in ${CONFIG_PATH} ({ "username", "password", "origin" }) and start a new session.`],
    [/ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED/, "The server closed the connection immediately: usually http:// used on an https port or vice versa — try the other scheme."],
    [/ERR_CERT|SSL|ERR_SSL/, "TLS/certificate problem. ignoreHTTPSErrors is " + (cfg.ignoreHTTPSErrors ? "on, so this is a protocol error (wrong port? http vs https?)" : `OFF in ${CONFIG_PATH} — turn it on for self-signed certificates`) + "."],
    [/ERR_EMPTY_RESPONSE|ERR_INVALID_HTTP_RESPONSE|ERR_SSL_PROTOCOL_ERROR/, "The server answered with something that is not HTTP: check http vs https and the port."],
    [/ERR_INVALID_URL|Protocol error|invalid URL/i, "The URL is not valid."],
  ]
  const hint = hints.find(([re]) => re.test(msg))?.[1]
  return hint ? `${msg}\n${hint}` : msg
}

/** "localhost:5173" o "192.168.1.10:3000/app" → con http:// davanti. */
function normalizeUrl(u) {
  const t = String(u ?? "").trim()
  if (!t || /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(data|about|blob|javascript|file):/i.test(t)) return t
  return `http://${t}`
}

/** Le credenziali in un URL (https://utente:password@host) non vanno ripetute nel testo. */
const maskUrl = (u) => String(u).replace(/(\/\/)[^/@\s]+@/g, "$1***@")

function href(u) {
  try {
    return new URL(u).href
  } catch {
    return null
  }
}

/**
 * Naviga la scheda attiva. Se fallisce lo dice con l'errore VERO di Chromium:
 * uno screenshot della pagina precedente sotto il nome di quella chiesta
 * sarebbe peggio di nessuna immagine. Serializzata con un lock.
 */
function navigate(s, rawUrl, { reload = false } = {}) {
  const url = normalizeUrl(rawUrl)
  const run = async () => {
    // Già lì? Allora niente reload (salvo richiesta): butterebbe via lo stato
    // costruito dall'HMR e dai click, e rilancerebbe gli errori di caricamento
    // come se fossero nuovi.
    const target = href(url)
    const current = href(s.page.url())
    if (s.navigated && target && current && target === current) {
      if (!reload) {
        return {
          ok: true,
          note:
            "already on this URL, page NOT reloaded (its state is kept). If you edited files and the server has no " +
            "hot reload, pass reload: true or you are looking at the old version.",
        }
      }
      try {
        s.lastToolNavAt = Date.now()
        await s.page.reload({ waitUntil: "domcontentloaded", timeout: cfg.navigationTimeoutMs })
      } catch (e) {
        if (/Timeout \d+ms exceeded/.test(String(e?.message ?? e))) {
          await guard(
            s.context.newCDPSession(s.page).then((c) => c.send("Page.stopLoading")),
            3000,
            "reloading",
          ).catch((e2) => {
            if (e2?.frozen) throw e2
          })
        }
        return { ok: false, note: explainNavError(e?.message ?? e, url) }
      }
      return { ok: true, note: "page reloaded" }
    }

    // Una navigazione fallita fa caricare a Chromium la sua pagina d'errore
    // (chrome-error://) un attimo DOPO che goto() ha già rifiutato. Se la
    // navigazione successiva parte prima, quella pagina d'errore la
    // sovrascrive: visto un "ok" con lo screenshot dell'errore precedente.
    // Quindi: dopo un fallimento si aspetta che l'errore sia caricato, e dopo
    // ogni goto si VERIFICA che la scheda mostri davvero la pagina chiesta.
    const onErrorPage = () => s.page.url().startsWith("chrome-error://")
    const settleError = () =>
      s.page.waitForURL((u) => u.protocol === "chrome-error:", { timeout: 1500 }).catch(() => {})
    // Una navigazione andata in timeout resta IN CORSO: da lì ogni evaluate
    // aspetta che finisca, cioè per sempre se il server non risponde (visto:
    // tool bloccato per minuti). Va fermata esplicitamente.
    // Anche fermare il caricamento può non tornare mai, se è la pagina a
    // essere bloccata (uno <script>while(true){}</script> nel documento):
    // allora è una pagina congelata.
    const stopLoading = async () => {
      try {
        await guard(
          (async () => {
            const cdp = await s.context.newCDPSession(s.page)
            await cdp.send("Page.stopLoading")
            await cdp.detach().catch(() => {})
          })(),
          3000,
          "loading",
        )
      } catch (e) {
        if (e?.frozen) throw e
      }
    }
    const goOnce = async () => {
      try {
        s.lastToolNavAt = Date.now()
        return await s.page.goto(url, { waitUntil: "domcontentloaded", timeout: cfg.navigationTimeoutMs })
      } catch (e) {
        if (/Timeout \d+ms exceeded/.test(String(e?.message ?? e))) await stopLoading()
        throw e
      }
    }
    const go = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await goOnce()
        } catch (e) {
          const msg = String(e?.message ?? e)
          if (attempt === 0 && /interrupted by another navigation/.test(msg)) {
            await settleError()
            continue
          }
          await settleError()
          throw e
        }
        // Un attimo per far emergere una pagina d'errore in ritardo.
        await s.page.waitForTimeout(50)
        if (!onErrorPage()) return
        if (attempt === 0) {
          await settleError()
          continue
        }
      }
      throw new Error(`net::ERR_FAILED the tab ended up on Chromium's error page instead of ${url}`)
    }
    let note = null
    try {
      // Non `load`: aspetta ogni sotto-risorsa, e un dev server ne tiene spesso
      // una aperta per sempre. Basta l'HTML analizzato; decide poi `settle`.
      await goWithLiveness(go(), s.page, url)
    } catch (e) {
      // Una pagina che si blocca MENTRE si carica non è un errore di
      // navigazione qualunque: il flag `frozen` deve arrivare a safe(), che
      // riavvia Chromium e non riapre una pagina che si blocca da sola. Se
      // restasse qui, la chiamata successiva riaprirebbe la stessa pagina
      // congelata (misurato: 53 s persi per riavere lo stesso blocco).
      if (e?.frozen) throw e
      const msg = String(e?.message ?? e)
      if (/ERR_CONNECTION_REFUSED/.test(msg) && cfg.autoStart && isLocal(url)) {
        const started = await startDevServer(url)
        if (!started.ok) return { ok: false, note: `${explainNavError(msg, url)}\n${started.note}` }
        try {
          await go()
          note = started.note
        } catch (e2) {
          return { ok: false, note: `${started.note}, but: ${explainNavError(e2?.message ?? e2, url)}` }
        }
      } else {
        return { ok: false, note: explainNavError(msg, url) }
      }
    }
    s.navigated = true
    lastUrl = url
    return { ok: true, note }
  }
  const next = navLock.then(run, run)
  navLock = next.catch(() => {})
  return next
}

/**
 * Quando "fotografare". Un canvas animato non diventa mai stabile al pixel,
 * quindi "aspetta che l'immagine smetta di cambiare" è la regola sbagliata. Si
 * preferisce un segnale esplicito dall'app (`window.__renderReady = true`),
 * poi qualche frame se c'è un canvas, le transizioni CSS finite (sennò si
 * fotografa una barra a metà della sua animazione: è successo) e una rete
 * tranquilla.
 */
async function settle(page, waitMs, { afterAction = false, selfMutating = false } = {}) {
  let signal = "none"
  const flagState = await guard(
    page.evaluate(() => {
      const v = window.__renderReady
      return v === true ? "ready" : typeof v === "undefined" ? "absent" : "pending"
    }),
    5000,
    "waiting for it to render",
  ).catch((e) => {
    if (e?.frozen) throw e
    return "absent"
  })

  if (flagState === "ready") signal = "window.__renderReady"
  else if (flagState === "pending") {
    signal =
      (await page
        .waitForFunction(() => window.__renderReady === true, null, { timeout: 5000 })
        .then(() => "window.__renderReady")
        .catch(() => null)) ?? "none"
  }
  if (signal === "none") {
    const hasCanvas = await page.$("canvas").then((c) => !!c).catch(() => false)
    signal = hasCanvas ? "canvas + frames" : "DOM"
  }

  if (waitMs && waitMs > 0) await page.waitForTimeout(waitMs)

  // Dopo un'azione, quello che la pagina fa "subito dopo" (un toast mostrato da
  // un setTimeout, un elenco che si aggiorna) arriva qualche centinaio di ms
  // più tardi: senza aspettarlo lo screenshot lo perde. Si aspetta che il DOM
  // stia fermo per 400 ms, al massimo 1,5 s (una pagina con un orologio non
  // sta mai ferma).
  if (afterAction) {
    await guard(
      page.evaluate(
        (cap) =>
          new Promise((res) => {
            let quiet
            const end = setTimeout(done, cap)
            const obs = new MutationObserver(() => {
              clearTimeout(quiet)
              quiet = setTimeout(done, 400)
            })
            function done() {
              obs.disconnect()
              clearTimeout(end)
              clearTimeout(quiet)
              res()
            }
            obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
            quiet = setTimeout(done, 400)
          }),
        // Una pagina che cambia da sola (orologio, countdown, barra di
        // avanzamento) non sta mai ferma: aspettarla costava 1,6 s per azione.
        selfMutating ? 600 : 1500,
      ),
      5000,
      "waiting for the page to react",
    ).catch((e) => {
      if (e?.frozen) throw e
    })
  }

  // Animazioni e transizioni FINITE (quelle infinite, come uno spinner, non
  // finiranno mai e non si aspettano), poi due frame perché il paint avvenga.
  await guard(
    page.evaluate(async () => {
      const deadline = performance.now() + 1500
      while (performance.now() < deadline) {
        const finite = document.getAnimations().filter((a) => {
          if (a.playState !== "running") return false
          const end = a.effect?.getComputedTiming?.().endTime
          return typeof end === "number" && Number.isFinite(end)
        })
        if (!finite.length) break
        await new Promise((r) => setTimeout(r, 50))
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    }),
    5000,
    "waiting for its animations",
  ).catch((e) => {
    if (e?.frozen) throw e
  })

  // Osservatore permanente (fino alla prossima navigazione): alla prossima
  // azione dirà se la pagina stava già cambiando da sola.
  await guard(
    page.evaluate(() => {
      if (window.__wvObs) return
      window.__wvMuts = []
      window.__wvObs = new MutationObserver(() => {
        const a = window.__wvMuts
        a.push(performance.now())
        if (a.length > 50) a.splice(0, a.length - 50)
      })
      window.__wvObs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
    }),
    2000,
    "installing an observer",
  ).catch((e) => {
    if (e?.frozen) throw e
  })

  // Rete tranquilla. Mai `networkidle`: il websocket HMR di un dev server è
  // sempre aperto e quella condizione non scatta mai.
  const s = session
  if (s) {
    for (let i = 0; i < 40; i++) {
      const now = Date.now()
      const inflight = [...s.pending.values()].filter((t0) => now - t0 < 5000).length
      if (inflight === 0 && now - s.lastActivity > 250) break
      await page.waitForTimeout(50)
    }
  } else await page.waitForTimeout(300)
  return signal
}

/**
 * Screenshot con un secondo tentativo (sotto carico il primo può fallire).
 * Restituisce { buf, note }: la nota dice se la pagina è stata tagliata.
 */
async function shot(s, opts = {}) {
  let note = null
  let clip
  if (opts.fullPage) {
    const [h, w] = await guard(
      s.page.evaluate(() => [document.documentElement.scrollHeight, document.documentElement.scrollWidth]),
      5000,
      "measuring it",
    ).catch((e) => {
      if (e?.frozen) throw e
      return [0, 0]
    })
    if (h > cfg.maxFullPageHeight) {
      // Il ritaglio taglia anche la LARGHEZZA, se la pagina è più larga della
      // finestra: dirlo, o la parte destra sparisce senza che il modello lo sappia.
      const wide = w > cfg.viewport.width
      clip = { x: 0, y: 0, width: cfg.viewport.width, height: cfg.maxFullPageHeight }
      note =
        `the page is ${h}px tall${wide ? ` and ${w}px wide` : ""}: full_page captured only the top ` +
        `${cfg.maxFullPageHeight}px${wide ? ` and the left ${cfg.viewport.width}px` : ""} (a bigger image reaches you ` +
        `shrunk until unreadable). Scroll and look, or screenshot a selector, to see the rest.`
    }
  }
  const take = () =>
    opts.selector
      ? locate(s.page, opts.selector, opts.frame).first().screenshot({ type: "jpeg", quality: cfg.jpegQuality, timeout: 5000 })
      : s.page.screenshot({ type: "jpeg", quality: cfg.jpegQuality, fullPage: !!opts.fullPage, clip, timeout: 10000 })
  // Uno screenshot che non arriva può voler dire pagina congelata: lo si
  // verifica subito invece di aspettare un secondo timeout.
  const alive = () => guard(s.page.evaluate("1"), 2000, "taking the screenshot")
  let buf
  try {
    buf = await take()
  } catch (e) {
    await alive()
    if (opts.selector) throw e
    await s.page.waitForTimeout(400)
    buf = await take()
  }
  if (!buf || buf.length === 0) throw new Error("Chromium returned an empty screenshot")
  return { buf, note }
}

/** Testo dell'overlay di errore di Vite: sta in uno shadow DOM, fuori dalla console. */
async function viteOverlay(page) {
  return guard(
    page.evaluate(() => {
      const o = document.querySelector("vite-error-overlay")
      if (!o) return null
      const r = o.shadowRoot
      const pick = (sel) => r?.querySelector(sel)?.innerText?.trim() ?? ""
      return [pick(".message"), pick(".file"), pick(".frame")].filter(Boolean).join("\n") || "(overlay present)"
    }),
    3000,
    "reading the error overlay",
  ).catch(() => null)
}

/** Gli errori che React stampa come warning restano errori. */
function isReactError(text) {
  return /An error occurred in the <|error boundary|Uncaught Error|The above error occurred/i.test(text)
}

function problemsOf(entries) {
  return entries.filter(
    (e) =>
      e.kind === "error" ||
      e.kind === "failed" ||
      e.kind === "http" ||
      (e.kind === "console" && (e.level === "error" || isReactError(e.text))),
  )
}

async function describe(s, signal, note) {
  const fresh = s.log.slice(s.lookCursor)
  s.lookCursor = s.log.length
  const droppedNow = (s.dropped ?? 0) - (s.droppedSeenByLook ?? 0)
  s.droppedSeenByLook = s.dropped ?? 0
  const problems = problemsOf(fresh)
  const warns = fresh.filter((e) => e.kind === "console" && e.level === "warning" && !isReactError(e.text))
  const events = fresh.filter((e) => e.kind === "dialog" || e.kind === "tab")
  const net = fresh.filter((e) => e.kind === "net")
  const lines = [
    `URL: ${maskUrl(s.page.url())}`,
    `Title: ${await guard(s.page.title(), 3000, "reading its title").catch(() => "")}`,
    `Viewport: ${cfg.viewport.width}x${cfg.viewport.height}`,
    `Render readiness: ${signal}`,
  ]
  const pages = s.context.pages()
  if (pages.length > 1) {
    lines.push(`Open tabs (switch with browser_act switch_tab):`)
    pages.forEach((p, i) => lines.push(`  [${i}] ${maskUrl(p.url())}${p === s.page ? "   ← shown" : ""}`))
  }
  if (restartNote) {
    lines.push(`Note: ${restartNote}`)
    restartNote = null
  }
  if (note) lines.push(`Note: ${note}`)

  const overlay = await viteOverlay(s.page)
  if (overlay) {
    lines.push("", "Vite ERROR OVERLAY is covering the page (it also blocks clicks) — fix the source:", "  " + overlay.slice(0, 1500).replace(/\n/g, "\n  "))
  }
  if (events.length) {
    lines.push("", "Events:")
    for (const e of events.slice(-10)) lines.push(`  [${e.kind}] ${e.text}`)
  }
  if (problems.length) {
    lines.push("", `Problems since the last look (${problems.length}):`)
    for (const e of problems.slice(-25)) lines.push(`  [${e.kind}] ${e.text.slice(0, 800)}`)
    // Gli stack di un dev server puntano al codice TRASFORMATO (JSX compilato,
    // import riscritti): la riga non è quella del sorgente. Visto un modello
    // concludere "source map sbagliata" da questo.
    if (problems.some((e) => /\.(jsx|tsx|ts|vue|svelte)(\?[^:\s]*)?:\d+:\d+|\/@fs\/|\/src\/[^\s]*\?t=\d+/.test(e.text))) {
      lines.push(
        "  (line:column in these stacks refer to the code as TRANSFORMED by the dev server, not your source file: " +
          "use the function/component name to find the spot, not the line number.)",
      )
    }
  }
  if (warns.length) {
    lines.push("", `Warnings (${warns.length}):`)
    for (const e of warns.slice(-8)) lines.push(`  ${e.text.slice(0, 300)}`)
  }
  if (!problems.length && !warns.length && !overlay) {
    lines.push("", "No console errors, page errors or failed requests since the last look.")
  }
  if (net.length) lines.push("", `Network: ${net.length} fetch/XHR completed since the last look (details: browser_console).`)
  if (droppedNow > 0) {
    lines.push(`(The page logged so much that the ${droppedNow} oldest entries were discarded: the buffer keeps the last ${MAX_LOG}.)`)
  }
  lines.push(
    "",
    "The attached image is the page exactly as it renders right now. Judge the result from the image, not from the source you wrote.",
  )
  return lines.join("\n")
}

const text = (t) => ({ content: [{ type: "text", text: t }] })
const textError = (t) => ({ content: [{ type: "text", text: t }], isError: true })

function navFailed(url, note) {
  return textError(
    [
      `Could not open ${maskUrl(normalizeUrl(url))}.`,
      maskUrl(note ?? ""),
      "",
      "No screenshot was taken: the browser is not showing that page, and an image of whatever it shows " +
        "instead would be misleading.",
    ]
      .filter((l) => l !== "")
      .join("\n"),
  )
}

function withImage(output, buf, isError = false) {
  const r = {
    content: [
      { type: "text", text: output },
      { type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" },
    ],
  }
  if (isError) r.isError = true
  return r
}

/** Un selettore, nella pagina o dentro l'iframe indicato da `frame`. */
const locate = (page, selector, frame) => (frame ? page.frameLocator(frame).locator(selector) : page.locator(selector))

/** Se il selettore non c'è nella pagina ma c'è in un iframe, il modo di raggiungerlo. */
async function findInFrames(page, selector) {
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue
    const n = await guard(f.locator(selector).count(), 2000, "searching iframes").catch(() => 0)
    if (!n) continue
    const sel = await guard(
      f.frameElement().then((h) =>
        h.evaluate((el) => {
          if (el.id) return `#${CSS.escape(el.id)}`
          if (el.name) return `iframe[name="${el.name}"]`
          const src = el.getAttribute("src")
          return src ? `iframe[src="${src}"]` : "iframe"
        }),
      ),
      2000,
      "reading the iframe",
    ).catch(() => "iframe")
    return sel
  }
  return null
}

/** Perché un'azione su un selettore non è riuscita, detto in modo utile. */
async function diagnose(page, selector, err, frame) {
  const raw = clean(err?.message ?? err)
  if (!selector) return raw.split("\n")[0]
  const loc = locate(page, selector, frame)
  const n = await guard(loc.count(), 3000, "looking for the element").catch((e) => (e?.frozen ? -2 : -1))
  if (n === -2) throw new FrozenPage("looking for the element")
  if (n === 0) {
    if (!frame) {
      const iframe = await findInFrames(page, selector)
      if (iframe) return `\`${selector}\` is not in the page itself but INSIDE AN IFRAME: repeat the action with frame: ${JSON.stringify(iframe)}.`
    }
    return `No element matches \`${selector}\`${frame ? ` inside the iframe \`${frame}\`` : ""}. Check the selector against the page (browser_eval can list candidates).`
  }
  if (n < 0) return `\`${selector}\` is not a valid selector: ${raw.split("\n")[0]}`
  const visible = await guard(loc.first().isVisible(), 3000, "checking visibility").catch(() => false)
  if (!visible) {
    return (
      `${n} element(s) match \`${selector}\` but the first one is NOT VISIBLE (display:none, zero size, off-screen in a ` +
      `closed container, or shown only on hover). If it appears on hover, hover its parent first.`
    )
  }
  const cover = /<([^>]+)>[^\n]*intercepts pointer events/.exec(raw)
  if (cover) {
    const what = cover[1].startsWith("vite-error-overlay") ? "the Vite error overlay (a compile error)" : `<${cover[1].slice(0, 120)}>`
    return `\`${selector}\` is visible but covered by ${what}, which receives the click instead.`
  }
  if (/not an? (<input>|<select>|input|select)|Element is not an|not a checkbox|Malformed value/i.test(raw)) {
    return `${raw.split("\n")[0]}\n(type fills text-like inputs; use kind "select" for <select>, "check"/"uncheck" for checkboxes and radios, "set_value" for range/date/color, and dates must be YYYY-MM-DD.)`
  }
  return raw.split("\n").slice(0, 3).join("\n")
}

/**
 * Ogni tool passa da qui: le chiamate sono SERIALIZZATE (una alla volta: un
 * click e uno sguardo in parallelo si pestavano i piedi, e uno screenshot
 * poteva essere della pagina sbagliata), un errore diventa un messaggio
 * leggibile invece di far cadere il server, e una pagina congelata viene
 * sostituita da un Chromium nuovo.
 */
let opLock = Promise.resolve()
function safe(fn, { loads = () => false } = {}) {
  return (args) => {
    const run = async () => {
      busy++
      touch()
      try {
        return await fn(args ?? {})
      } catch (e) {
        if (e?.frozen) {
          // Se la pagina si è bloccata MENTRE si caricava, riaprirla la
          // bloccherebbe di nuovo: si riparte dall'URL di default. Se invece si
          // è bloccata per un'azione (un click), la pagina in sé si carica bene
          // e si riapre quella.
          if (loads(args ?? {})) lastUrl = null
          await recover(e.message)
          return textError(
            `web-vision: ${e.message} — its JavaScript is stuck (an endless loop or a very long task). Chromium was ` +
              `restarted; the next call reopens ${startUrl()}${lastUrl ? " — if the loop runs on page load, it will freeze again" : ""}.`,
          )
        }
        return textError(`web-vision: ${clean(e?.message ?? e).split("\n").slice(0, 4).join("\n")}`)
      } finally {
        busy--
        touch()
        // L'ultima pagina VERA (anche raggiunta con un click), da cui ripartire
        // dopo la chiusura per inattività.
        const u = session && !session.page.isClosed() ? session.page.url() : ""
        if (/^https?:/.test(u)) lastUrl = u
        if (u && lastFrozenUrl && href(u) !== href(lastFrozenUrl)) lastFrozenUrl = null
        scheduleSave(session)
      }
    }
    const p = opLock.then(run, run)
    opLock = p.catch(() => {})
    return p
  }
}

async function ensureOpen(s) {
  if (s.navigated) return null
  const url = startUrl()
  const r = await navigate(s, url)
  return r.ok ? null : navFailed(url, r.note)
}

// --------------------------------------------------------------------------
// server MCP
// --------------------------------------------------------------------------

const server = new McpServer(
  { name: "web-vision", version: "2.0.0" },
  {
    instructions:
      "You have browser_* tools that drive a real headless Chromium (no extension, not the user's browser) on any " +
      "frontend reachable from this machine — localhost, LAN or hosted, http or https — and return a screenshot you " +
      "can actually see after every action. Use browser_open/browser_look to see, browser_act to operate the UI " +
      "(click, type, select, check, drag, upload, keys…), browser_console for logs and network, browser_eval to read " +
      "state. Whenever you change anything visual, look at it and judge from the image. Do not report a UI change or " +
      "a UI flow as working without having seen it.\n" +
      "Rules that avoid false conclusions:\n" +
      "- The page is NOT reloaded between looks. With a hot-reloading dev server (Vite, Next, webpack) that is what " +
      "you want; after editing files served without hot reload, use browser_look with reload: true.\n" +
      "- React/Vue/Angular inputs: change values with browser_act (type, select, check, set_value), NEVER by " +
      "assigning .value/.checked in browser_eval — the screenshot would show the new value while the app state " +
      "keeps the old one.\n" +
      "- Test flows through the UI. Never create or modify server data with fetch inside browser_eval unless the user " +
      "asks for it.\n" +
      "- These tool texts are in English for brevity: keep answering the user in the user's language.",
  },
)

server.registerTool(
  "browser_look",
  {
    title: "Look at the page",
    description:
      "Screenshot the live web app and SEE it. Returns a real image of the page as it renders right now, plus page " +
      "errors, console errors and warnings, failed requests, dialogs and new tabs since the last look. Call it after " +
      "every change to markup, styles, canvas or scene. Never claim a visual change works without looking at it.",
    inputSchema: {
      url: z.string().optional().describe("Navigate here first (http or https, local, LAN or hosted). Defaults to the current page."),
      reload: z
        .boolean()
        .optional()
        .describe("Reload before looking. Needed after editing files served WITHOUT hot reload; otherwise you see the old version."),
      wait_ms: z.number().optional().describe("Extra settle time in ms (slow animations, delayed content)."),
      full_page: z.boolean().optional().describe("Capture the whole scrollable page instead of the viewport."),
      selector: z.string().optional().describe("Screenshot only this element (CSS selector)."),
      frame: z.string().optional().describe("Selector of an <iframe> containing `selector`."),
      reason: z.string().optional().describe("What you are checking."),
    },
  },
  safe(async (args) => {
    const s = await ensureSession()
    let note = null
    const url = args.url ?? (!s.navigated ? startUrl() : args.reload ? s.page.url() : null)
    if (url) {
      const r = await navigate(s, url, { reload: !!args.reload })
      if (!r.ok) return navFailed(url, r.note)
      note = r.note
    }
    const signal = await settle(s.page, args.wait_ms)
    let shotRes
    try {
      shotRes = await shot(s, { selector: args.selector, frame: args.frame, fullPage: args.full_page })
    } catch (e) {
      if (e?.frozen) throw e
      return textError(await diagnose(s.page, args.selector, e, args.frame))
    }
    return withImage(await describe(s, signal, [note, shotRes.note].filter(Boolean).join("\n") || null), shotRes.buf)
  }, { loads: (a) => !!(a.url || a.reload) }),
)

server.registerTool(
  "browser_open",
  {
    title: "Open a URL",
    description:
      "Load a URL (http or https, local, LAN or hosted) and see the result. Always loads the current version: if the " +
      "URL is already open it is reloaded (page state is reset). To look again without resetting state, use browser_look.",
    inputSchema: {
      url: z.string().describe("URL to open, e.g. http://127.0.0.1:5173 or https://staging.example.com"),
      full_page: z.boolean().optional().describe("Capture the whole scrollable page."),
    },
  },
  safe(async (args) => {
    const s = await ensureSession()
    // "Apri questa pagina" vuol dire la versione di ADESSO: sulla stessa URL si
    // ricarica, invece di restituire in silenzio la pagina già aperta.
    const r = await navigate(s, args.url, { reload: true })
    if (!r.ok) return navFailed(args.url, r.note)
    const signal = await settle(s.page)
    const { buf, note } = await shot(s, { fullPage: args.full_page })
    return withImage(await describe(s, signal, [r.note, note].filter(Boolean).join("\n") || null), buf)
  }, { loads: () => true }),
)

const ACT_KINDS = [
  "click",
  "click_at",
  "dblclick",
  "right_click",
  "hover",
  "focus",
  "type",
  "clear",
  "press",
  "select",
  "check",
  "uncheck",
  "set_value",
  "upload",
  "drag",
  "scroll",
  "wait_for",
  "back",
  "forward",
  "switch_tab",
  "close_tab",
]
const NEEDS_SELECTOR = new Set(["click", "dblclick", "right_click", "hover", "focus", "type", "clear", "select", "check", "uncheck", "set_value", "upload", "drag", "wait_for"])

server.registerTool(
  "browser_act",
  {
    title: "Operate the page",
    description:
      "Do something on the live page and SEE the result: a screenshot is returned after every action, also when the " +
      "action fails (with the reason: no such element, hidden, covered…). Kinds:\n" +
      "click | dblclick | right_click | hover | focus — on `selector` (add `frame` for elements inside an iframe).\n" +
      "click_at — click at viewport coordinates `x`,`y` (for canvas, maps, charts).\n" +
      "type — fill a text-like input/textarea with `text` (replaces the content; dates must be YYYY-MM-DD).\n" +
      "clear — empty an input.\n" +
      "press — a key or chord in `key` (Enter, Escape, Tab, ArrowDown, Control+A…), on `selector` if given, `repeat` times.\n" +
      "select — choose an <option> of a <select> by value or visible label: `text` (or `values` for multi-select).\n" +
      "check / uncheck — a checkbox or radio (idempotent).\n" +
      "set_value — set `text` on range/date/color/any input in a way React/Vue see (fires input+change).\n" +
      "upload — set files on an <input type=file>: `files` (absolute paths).\n" +
      "drag — drag `selector` onto `target`, or by `dx`/`dy` pixels.\n" +
      "scroll — by `value` pixels (positive = down), or bring `selector` into view.\n" +
      "wait_for — wait for `selector` to reach `state` (visible, hidden, attached, detached).\n" +
      "back / forward — browser history.\n" +
      "switch_tab — make another tab active: `value` = its index (as listed under Open tabs) or `text` = part of its URL/title.\n" +
      "close_tab — close the active tab (or the one in `value`) and go back to the previous one.",
    inputSchema: {
      kind: z.enum(ACT_KINDS).describe("The action."),
      selector: z.string().optional().describe("CSS selector (Playwright selectors like text=Save also work)."),
      frame: z
        .string()
        .optional()
        .describe("Selector of an <iframe>: the action's selector is then looked up inside that iframe."),
      x: z.number().optional().describe("Viewport x in CSS pixels for click_at (canvas, maps)."),
      y: z.number().optional().describe("Viewport y in CSS pixels for click_at."),
      text: z.string().optional().describe("Text for type/set_value, option value or label for select."),
      values: z.array(z.string()).optional().describe("Several options for a multi-select."),
      key: z.string().optional().describe("Key for press, e.g. Enter, Escape, ArrowDown, Control+A."),
      repeat: z.number().optional().describe("How many times to press the key (default 1)."),
      value: z.number().optional().describe("Pixels to scroll (positive is down)."),
      target: z.string().optional().describe("Drop target selector for drag."),
      dx: z.number().optional().describe("Horizontal drag distance in pixels."),
      dy: z.number().optional().describe("Vertical drag distance in pixels."),
      files: z.array(z.string()).optional().describe("Absolute file paths for upload."),
      state: z.enum(["visible", "hidden", "attached", "detached"]).optional().describe("State for wait_for (default visible)."),
      timeout_ms: z.number().optional().describe("How long to wait for the element (default 5000). Raise it when the element is expected to appear late, including an element that is in the DOM but hidden and becomes visible later."),
      wait_ms: z.number().optional().describe("Extra wait after the action, before the screenshot."),
      full_page: z.boolean().optional().describe("Screenshot the whole page."),
      describe: z.string().optional().describe("What you expect to happen."),
    },
  },
  safe(async (args) => {
    const s = await ensureSession()
    const notOpen = await ensureOpen(s)
    if (notOpen) return notOpen
    let failure = null
    if (NEEDS_SELECTOR.has(args.kind) && !args.selector) failure = `browser_act ${args.kind} needs a selector — nothing was done.`
    else if (args.kind === "drag" && !args.target && args.dx == null && args.dy == null) {
      failure = "browser_act drag needs a target selector or dx/dy — nothing was done."
    }
    const page = s.page
    const timeout = args.timeout_ms ?? cfg.actionTimeoutMs
    if (!failure && args.kind === "type" && args.text == null) failure = "browser_act type needs text — nothing was done."
    // Per le azioni "da utente" si usa il primo elemento VISIBILE: con
    // `text=Annulla` veniva preso un <option> nascosto ("Annullati") anche se
    // c'era un pulsante visibile. Upload, select, set_value e wait_for lavorano
    // anche su elementi nascosti (input file e select stilizzati lo sono spesso).
    const POINTER = new Set(["click", "dblclick", "right_click", "hover", "focus", "type", "clear", "press", "check", "uncheck", "drag"])
    const raw = () => locate(page, args.selector, args.frame)
    const el = () => (POINTER.has(args.kind) ? raw().filter({ visible: true }).first() : raw().first())
    // La pagina stava già cambiando da sola prima dell'azione?
    const selfMutating = await guard(
      page.evaluate(() => {
        const t = performance.now()
        return (window.__wvMuts || []).filter((x) => t - x < 1000).length >= 2
      }),
      2000,
      "checking page activity",
    ).catch((e) => {
      if (e?.frozen) throw e
      return false
    })
    // Un elemento che ESISTE ma resta nascosto fa fallire subito l'azione dopo
    // 1,5 s (prima si aspettava tutto il timeout, 5 s): quasi sempre è un menu
    // che si apre al passaggio del mouse, non qualcosa che sta per comparire. Se
    // però il modello ha chiesto ESPLICITAMENTE di aspettare di più
    // (`timeout_ms`), quel tempo va rispettato: una modale che si apre dopo 2 s
    // non è un elemento nascosto, e fallire a 1,5 s ignorando il parametro
    // sarebbe un rifiuto a caso.
    const hiddenLimit = args.timeout_ms != null ? timeout : Math.min(1500, timeout)
    const visibleOrFail = async () => {
      if (!args.selector || !POINTER.has(args.kind) || (args.kind === "press" && !args.selector)) return
      const deadline = Date.now() + timeout
      let hiddenSince = null
      while (Date.now() < deadline) {
        const vis = await guard(raw().filter({ visible: true }).count(), 3000, "looking for the element")
        if (vis > 0) return
        const all = await guard(raw().count(), 3000, "looking for the element")
        if (all > 0) {
          hiddenSince ??= Date.now()
          if (Date.now() - hiddenSince > hiddenLimit) throw new Error("element is not visible")
        } else hiddenSince = null
        await new Promise((r) => setTimeout(r, 100))
      }
      // Scaduto il tempo senza che l'elemento compaia, si fallisce QUI. Lasciar
      // partire lo stesso l'azione faceva consumare un secondo `timeout` dentro
      // Playwright, e il limite complessivo dell'azione (timeout + 5 s) scattava
      // per primo: un refuso nel selettore sembrava una pagina congelata, e il
      // tool riavviava Chromium buttando via lo stato (misurato: 10,1 s e
      // riavvio per `#non-esiste-mai`).
      throw new Error(`no element matches \`${args.selector}\``)
    }

    // Tutta l'azione ha un limite di tempo: le azioni senza elemento
    // (click_at, press senza selettore, scroll, drag per coordinate) su una
    // pagina congelata non tornavano mai. Il limite copre il caso peggiore
    // reale: l'attesa dell'elemento nascosto (hiddenLimit) PIÙ l'attesa
    // dell'azione (timeout). Se fosse più stretto, la guard antigelo vincerebbe
    // per prima e un semplice selettore sbagliato sembrerebbe una pagina
    // bloccata (era il bug vero: 10,1 s e riavvio di Chromium).
    const limit =
      (["back", "forward"].includes(args.kind) ? cfg.navigationTimeoutMs : timeout) + Math.max(5000, hiddenLimit)
    if (!failure) try {
      await guard((async () => {
      await visibleOrFail()
      switch (args.kind) {
        case "click":
          await el().click({ timeout })
          break
        case "click_at":
          if (args.x == null || args.y == null) throw new Error("click_at needs x and y")
          await page.mouse.click(args.x, args.y)
          break
        case "dblclick":
          await el().dblclick({ timeout })
          break
        case "right_click":
          await el().click({ button: "right", timeout })
          break
        case "hover":
          await el().hover({ timeout })
          break
        case "focus":
          // focus() di Playwright non controlla la visibilità: su un elemento
          // nascosto "riusciva" senza che nulla cambiasse a schermo.
          await el().waitFor({ state: "visible", timeout })
          await el().focus({ timeout })
          break
        case "type":
          await el().fill(args.text ?? "", { timeout })
          break
        case "clear":
          await el().clear({ timeout })
          break
        case "press": {
          const n = Math.max(1, Math.min(100, args.repeat ?? 1))
          for (let i = 0; i < n; i++) {
            if (args.selector) {
              if (i === 0) await el().waitFor({ state: "visible", timeout })
              await el().press(args.key ?? "Enter", { timeout })
            }
            else await page.keyboard.press(args.key ?? "Enter")
          }
          break
        }
        case "select": {
          const wanted = args.values ?? [args.text ?? ""]
          await el().waitFor({ state: "attached", timeout })
          const opts = await guard(
            el().evaluate((n) => (n instanceof HTMLSelectElement ? [...n.options].map((o) => ({ value: o.value, label: o.label })) : null)),
            3000,
            "reading the options",
          )
          if (!opts) throw new Error(`\`${args.selector}\` is not a <select>. For custom dropdowns, click to open them and click the option.`)
          const missing = wanted.filter((w) => !opts.some((o) => o.value === w || o.label === w))
          if (missing.length) {
            throw new Error(
              `No option ${missing.map((m) => JSON.stringify(m)).join(", ")} in \`${args.selector}\`. Available: ` +
                opts.map((o) => (o.value === o.label ? JSON.stringify(o.value) : `${JSON.stringify(o.label)} (value ${JSON.stringify(o.value)})`)).join(", "),
            )
          }
          await el().selectOption(wanted, { timeout })
          break
        }
        case "check":
          await el().check({ timeout })
          break
        case "uncheck":
          await el().uncheck({ timeout })
          break
        case "set_value": {
          await el().waitFor({ state: "attached", timeout })
          const tag = await el().evaluate((n) => n.tagName)
          if (!["INPUT", "TEXTAREA", "SELECT"].includes(tag)) {
            throw new Error(`set_value works on <input>, <textarea> and <select>; \`${args.selector}\` is a <${tag.toLowerCase()}>.`)
          }
          await el().evaluate((node, v) => {
            // Il setter NATIVO, non `node.value = v`: React tiene traccia del
            // valore e ignorerebbe un'assegnazione diretta. Poi gli eventi che
            // i framework ascoltano.
            const proto =
              node instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : node instanceof HTMLSelectElement
                  ? HTMLSelectElement.prototype
                  : HTMLInputElement.prototype
            const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
            if (setter) setter.call(node, v)
            else node.value = v
            node.dispatchEvent(new Event("input", { bubbles: true }))
            node.dispatchEvent(new Event("change", { bubbles: true }))
          }, String(args.text ?? args.value ?? ""))
          break
        }
        case "upload":
          await el().setInputFiles(args.files ?? [], { timeout })
          break
        case "drag":
          if (args.target) {
            await el().dragTo(page.locator(args.target).first(), { timeout })
          } else {
            const box = await el().boundingBox({ timeout })
            if (!box) throw new Error(`\`${args.selector}\` has no box to drag`)
            const x = box.x + box.width / 2
            const y = box.y + box.height / 2
            await page.mouse.move(x, y)
            await page.mouse.down()
            await page.mouse.move(x + (args.dx ?? 0), y + (args.dy ?? 0), { steps: 12 })
            await page.mouse.up()
          }
          break
        case "scroll":
          if (args.selector) await el().scrollIntoViewIfNeeded({ timeout })
          else await page.mouse.wheel(0, args.value ?? 400)
          // Lo scroll è asincrono: senza aspettare che si fermi, lo screenshot
          // esce a metà (visto: mezza pagina vuota).
          await page
            .evaluate(async () => {
              let last = -1
              for (let i = 0; i < 30; i++) {
                await new Promise((r) => requestAnimationFrame(r))
                if (window.scrollY === last) break
                last = window.scrollY
              }
            })
            .catch(() => {})
          break
        case "wait_for":
          await el().waitFor({ state: args.state ?? "visible", timeout })
          break
        case "switch_tab": {
          const pages = s.context.pages()
          let to = null
          if (typeof args.value === "number") to = pages[args.value] ?? null
          else if (args.text) {
            const titles = await Promise.all(pages.map((p) => guard(p.title(), 2000, "reading a tab title").catch(() => "")))
            to = pages.find((p, i) => p.url().includes(args.text) || titles[i].includes(args.text)) ?? null
          }
          if (!to) throw new Error(`no such tab. Open tabs: ${pages.map((p, i) => `[${i}] ${p.url()}`).join("  ")}`)
          s.page = to
          await to.bringToFront().catch(() => {})
          break
        }
        case "close_tab": {
          const pages = s.context.pages()
          const victim = typeof args.value === "number" ? pages[args.value] : s.page
          if (!victim) throw new Error(`no tab ${args.value}`)
          if (pages.length === 1) throw new Error("this is the only tab: closing it would leave nothing to look at")
          await victim.close()
          if (s.page === victim || s.page.isClosed()) s.page = s.context.pages().at(-1)
          break
        }
        case "back":
        case "forward": {
          const before = page.url()
          const resp = await (args.kind === "back" ? page.goBack : page.goForward).call(page, { waitUntil: "domcontentloaded", timeout: cfg.navigationTimeoutMs })
          // Le SPA cambiano URL senza una risposta HTTP: conta l'URL, non la risposta.
          if (!resp && page.url() === before) {
            throw new Error(`nothing happened: there is no ${args.kind === "back" ? "previous" : "next"} page in this tab's history`)
          }
          // Prima della prima pagina c'è solo la pagina vuota iniziale: tornarci
          // e dire "ok" lascerebbe il modello davanti a uno schermo bianco.
          if (page.url() === "about:blank" && before !== "about:blank") {
            await page.goForward({ waitUntil: "domcontentloaded", timeout: cfg.navigationTimeoutMs }).catch(() => {})
            throw new Error(`there is no previous page in this tab's history (only the empty start page) — stayed on ${before}`)
          }
          break
        }
      }
      })(), limit, `performing ${args.kind}`)
    } catch (e) {
      if (e?.frozen) throw e
      const tgtMissing =
        args.kind === "drag" && args.target && (await guard(page.locator(args.target).count(), 3000, "looking for the drop target").catch(() => 1)) === 0
      failure = tgtMissing
        ? `No element matches the drop target \`${args.target}\`.`
        : await diagnose(page, args.selector, e, args.frame)
    }

    // La scheda attiva può essere cambiata (target=_blank): si fotografa quella.
    const signal = await settle(s.page, args.wait_ms, { afterAction: true, selfMutating })
    const { buf, note: shotNote } = await shot(s, { fullPage: args.full_page })
    const head = failure
      ? `Action FAILED: ${args.kind}${args.selector ? ` on ${args.selector}` : ""}\n${failure}\nThe screenshot shows the page as it is now, after the failed attempt.`
      : args.describe
        ? `Action: ${args.kind} — expected: ${args.describe}`
        : `Action: ${args.kind}${args.selector ? ` on ${args.selector}` : ""}`
    return withImage(`${head}\n\n${await describe(s, signal, shotNote)}`, buf, !!failure)
  }),
)

server.registerTool(
  "browser_console",
  {
    title: "Read console and network",
    description:
      "Read the page's console output, errors, dialogs, tab changes and network (fetch/XHR with status, failed " +
      "requests) without taking a screenshot. By default shows what is new since the last browser_console call — " +
      "independently of browser_look, which only summarizes.",
    inputSchema: {
      all: z.boolean().optional().describe("Show the whole buffer (last 1000 entries), not only what is new."),
      clear: z.boolean().optional().describe("Clear the buffer after reading."),
      only: z.enum(["problems", "console", "network"]).optional().describe("Filter the entries."),
    },
  },
  safe(async (args) => {
    const s = await ensureSession()
    const key = args.only ?? "all"
    let entries = args.all ? s.log.slice() : s.log.slice(s.consoleCursor[key])
    s.consoleCursor[key] = s.log.length
    if (args.only === "problems") entries = problemsOf(entries)
    else if (args.only === "console") entries = entries.filter((e) => e.kind === "console")
    else if (args.only === "network") entries = entries.filter((e) => e.kind === "net" || e.kind === "failed" || e.kind === "http")
    const dropped = s.dropped ?? 0
    if (args.clear) {
      s.log = []
      s.lookCursor = 0
      s.dropped = 0
      for (const k of Object.keys(s.consoleCursor)) s.consoleCursor[k] = 0
    }
    if (!entries.length) return text(args.all ? "The buffer is empty." : "Nothing new since the last browser_console call with this filter (use all: true for everything).")
    const head = args.all && dropped ? `(the oldest ${dropped} entries were discarded: the buffer keeps the last ${MAX_LOG})\n` : ""
    const body = entries.map((e) => `[${e.kind}] ${e.text}`).join("\n")
    return text(head + (body.length > 30000 ? `… ${body.length - 30000} chars cut from the start …\n${body.slice(-30000)}` : body))
  }),
)

server.registerTool(
  "browser_eval",
  {
    title: "Evaluate JavaScript in the page",
    description:
      "Run JavaScript in the live page and get the JSON result back, to read real app state (DOM, store, canvas, " +
      "computed styles). Accepts an expression, or statements (the value of the last expression is returned; " +
      "`return` and `await` also work). The code runs exactly once. Use it to READ state. Do NOT use it to change " +
      "form values in React/Vue apps (use browser_act) and do NOT use it to create, change or delete data with " +
      "fetch/XHR: that bypasses the UI you are supposed to test and writes to the real server — requests that " +
      "change data are reported. Set screenshot: true if the code changes what is on screen.",
    inputSchema: {
      js: z.string().describe("Expression or statements to evaluate in the page."),
      screenshot: z.boolean().optional().describe("Also return a screenshot after running the code."),
    },
  },
  safe(async (args) => {
    const s = await ensureSession()
    const notOpen = await ensureOpen(s)
    if (notOpen) return notOpen
    const prepared = prepareEval(args.js)
    if (prepared.error) return textError(prepared.error)
    const logStart = s.log.length
    const value = await guard(
      s.page.evaluate(async ({ body, indirect }) => {
        const AsyncFn = Object.getPrototypeOf(async function () {}).constructor
        const v = indirect != null ? await (0, eval)(indirect) : await new AsyncFn(body)()
        if (v === undefined) return undefined
        // Serializzato QUI, a qualsiasi profondità: ciò che JSON non sa
        // rappresentare (cicli, BigInt, Map, nodi DOM, funzioni) viene
        // descritto invece di far fallire la chiamata o sparire.
        const seen = new WeakSet()
        return JSON.stringify(v, (_k, x) => {
          if (typeof x === "bigint") return `${x}n`
          if (typeof x === "function") return `[function ${x.name || "anonymous"}]`
          if (typeof x === "symbol") return x.toString()
          if (typeof Node !== "undefined" && x instanceof Node) {
            return `[DOM node] ${x.nodeName}${x.id ? "#" + x.id : ""} ${(x.textContent ?? "").trim().slice(0, 200)}`
          }
          if (x instanceof Error) return `[Error] ${x.stack || x.message}`
          if (x instanceof Map) return { "[Map]": [...x.entries()] }
          if (x instanceof Set) return { "[Set]": [...x] }
          if (x && typeof x === "object") {
            if (seen.has(x)) return "[circular]"
            seen.add(x)
          }
          return x
        })
      }, { body: prepared.body ?? null, indirect: prepared.indirect ?? null }),
      cfg.evalTimeoutMs,
      `running browser_eval for ${Math.round(cfg.evalTimeoutMs / 1000)}s`,
    )
    let out
    const json = value === undefined ? undefined : JSON.stringify(JSON.parse(value), null, 2)
    if (json === undefined) {
      out =
        "The code returned undefined. (The value of the last expression statement is returned — if your code ends " +
        "with a block, a declaration or an if/for, end it with the value you want, or use `return`.)"
    } else out = json.length > 20000 ? `${json.slice(0, 20000)}\n… truncated (${json.length} chars)` : json
    // Un eval che fa POST/PUT/DELETE scrive dati sul server scavalcando la UI:
    // su uno staging vero nessuno se ne accorgerebbe. Lo si dice sempre.
    await new Promise((r) => setTimeout(r, 300))
    const writes = s.log
      .slice(Math.max(0, logStart - (s.dropped ?? 0)))
      .filter((e) => e.method && !["GET", "HEAD", "OPTIONS"].includes(e.method))
    if (writes.length) {
      out +=
        `\n\nWARNING: this eval sent ${writes.length} request(s) that can CHANGE DATA on the server:\n` +
        writes.slice(0, 10).map((e) => `  ${e.text}`).join("\n") +
        "\nTo test a flow, use the UI with browser_act; tell the user about data you created or changed this way."
    }
    if (!args.screenshot) return text(out)
    const signal = await settle(s.page)
    const { buf } = await shot(s)
    return withImage(`${out}\n\n${await describe(s, signal, null)}`, buf)
  }),
)

// Chromium non deve sopravvivere a Claude Code: alla chiusura dello stdin (o a
// un segnale) si salva il login, si chiude il browser e si esce.
async function shutdown() {
  // Una pagina congelata può bloccare anche il salvataggio e la chiusura:
  // l'uscita è garantita comunque, entro 8 s.
  setTimeout(() => process.exit(0), 8000).unref()
  if (idleTimer) clearTimeout(idleTimer)
  const s = session
  session = null
  if (s) {
    await guard(saveState(s), 3000, "saving the login").catch(() => {})
    await guard(s.browser.close(), 4000, "closing").catch(() => {})
  }
  process.exit(0)
}
process.stdin.on("close", shutdown)
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
process.on("SIGHUP", shutdown)

await server.connect(new StdioServerTransport())
log(`pronto (config: ${CONFIG_PATH}, progetto: ${PROJECT_DIR})`)
