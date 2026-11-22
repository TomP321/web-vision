# web_vision_claude_code

Un server **MCP** per **Claude Code** che usa un frontend vero al posto tuo e
ti fa vedere cosa succede. Il frontend può essere locale, in rete locale o
pubblicato, su http o https. Dopo **ogni azione** il modello riceve:

- lo **screenshot vero** della pagina;
- un resoconto veritiero di cosa è successo: errori JavaScript, errori di
  console, richieste fallite, dialog, nuove schede.

Non usa estensioni né il tuo Chrome: avvia un Chromium suo, isolato, che
Claude Code pilota tramite MCP.

| Tool (in Claude Code: `mcp__web-vision__…`) | Cosa fa |
|---|---|
| `browser_open` | apre un URL e lo mostra. Carica sempre la versione **attuale**: se la pagina è già aperta, la ricarica |
| `browser_look` | screenshot della pagina com'è adesso, senza ricaricarla (lo stato resta), e cosa è successo dall'ultimo sguardo. `reload: true` per ricaricarla |
| `browser_act` | **opera** sulla pagina e restituisce lo screenshot, **anche se l'azione fallisce**, con il motivo del fallimento |
| `browser_console` | console, errori, dialog, schede e rete (fetch/XHR con il loro stato), senza screenshot |
| `browser_eval` | esegue JavaScript nella pagina e ne restituisce il valore. Serve a **leggere** lo stato, non a modificare i form né a scrivere dati: se il codice manda richieste che modificano dati (POST, PUT, DELETE…) lo dice esplicitamente |

Le azioni di `browser_act`:

| Azione | Uso |
|---|---|
| `click`, `dblclick`, `right_click`, `hover`, `focus` | su un elemento (`selector`) |
| `click_at` | su coordinate `x`,`y`, per canvas, mappe e grafici |
| `type`, `clear` | campi di testo (le date vanno scritte `AAAA-MM-GG`) |
| `press` | tasti e combinazioni: `Enter`, `Escape`, `Tab`, `ArrowDown`, `Control+A`… anche ripetuti (`repeat`) |
| `select` | sceglie una voce di un `<select>` per valore o per testo visibile |
| `check`, `uncheck` | checkbox e radio |
| `set_value` | range, date, color o qualsiasi input, in modo che **React/Vue se ne accorgano** |
| `upload` | file su un `<input type=file>` |
| `drag` | trascina un elemento su un altro (`target`) o di `dx`/`dy` pixel |
| `scroll` | di N pixel, o fino a un elemento |
| `wait_for` | aspetta che un elemento compaia, sparisca, si attacchi o si stacchi |
| `back`, `forward` | cronologia |
| `switch_tab`, `close_tab` | schede aperte dalla pagina |

Per gli elementi **dentro un iframe** si aggiunge `frame` con il selettore
dell'iframe. Se ti dimentichi di farlo, il tool ti dice in quale iframe si
trova l'elemento.

Non c'è un'azione per aprire una scheda nuova: la si fa aprire alla pagina, con
`browser_eval` (`window.open("https://…")`), e poi ci si passa con `switch_tab`.

```
web_vision_claude_code/
├── server.mjs      il server MCP
├── config.json     URL di default, HTTPS, login, timeout… (vedi Configurazione)
├── selftest.mjs    prova autonoma: avvia il server e controlla le funzioni essenziali
├── install.sh      installa le dipendenze e Chromium, e lo registra in Claude Code
├── uninstall.sh    lo toglie da Claude Code (con --purge cancella anche login e cartella)
├── package.json
└── package-lock.json
```

---

## Installarlo su un Mac (o su Linux)

### 1. Requisiti

- **macOS 14 (Sonoma) o più recente**, Apple Silicon o Intel. Il Chromium di
  questa versione di Playwright non esiste per macOS 13 e precedenti: lì
  `install.sh` si ferma e lo dice. Su Linux va bene qualsiasi distribuzione
  recente.
- **Claude Code**, con il comando `claude` nel `PATH` (`claude --version`).
- **Node.js 20 o più recente** (`node --version`). Playwright si rifiuta di
  partire con la 18. Su Mac, se manca o è vecchio:

  ```bash
  brew install node        # oppure: brew upgrade node
  ```

Chromium **non** va installato a mano: lo scarica `install.sh`, una volta
sola (~180 MB di download, circa 400 MB su disco).

### 2. Copiare la cartella

La cartella si copia **senza `node_modules`**: le dipendenze vengono
reinstallate sul Mac, e sono tutte JavaScript puro, quindi non ci sono binari
Linux da portarsi dietro. Puoi usare la chiavetta, AirDrop o `scp`:

```bash
git clone https://github.com/TomP321/web-vision.git ~/web_vision_claude_code
```

### 3. Installare

**Come il tuo utente, senza `sudo`**: la registrazione dei server MCP in
Claude Code è per utente.

```bash
cd ~/web_vision_claude_code
bash install.sh
```

**Scegli prima dove tenere la cartella**, perché Claude Code registra il
percorso assoluto di `server.mjs`. Se poi la sposti, rilancia
`bash install.sh` dalla nuova posizione. Sul Mac la scelta più semplice è la
home (`~/web_vision_claude_code`), che non richiede permessi di
amministratore.

Cosa fa `install.sh`, in ordine:

1. controlla `node` ≥ 18, `npm` e `claude`;
2. `npm ci`, cioè le dipendenze alle versioni esatte del `package-lock.json`;
3. scarica Chromium se non c'è già. Su Mac va in
   `~/Library/Caches/ms-playwright`, su Linux in `~/.cache/ms-playwright`;
4. lancia `selftest.mjs`: **se non passa, non registra niente**;
5. `claude mcp add -s user web-vision -- node <cartella>/server.mjs`, cioè lo
   registra per **tutti i tuoi progetti**.

Per averlo solo in un progetto invece che ovunque, lancia lo script **dalla
cartella del progetto**:

```bash
cd ~/mio-progetto
WEB_VISION_SCOPE=local bash ~/web_vision_claude_code/install.sh
```

Per toglierlo, poi, si usa allo stesso modo `uninstall.sh`: dalla cartella
del progetto e con `WEB_VISION_SCOPE=local`.

#### Se sul Mac qualcosa si blocca

- **File che non si aprono dopo il trasferimento**: macOS li ha messi in
  quarantena. Toglila con

  ```bash
  xattr -dr com.apple.quarantine ~/web_vision_claude_code
  ```

- **«Permission denied» su `install.sh`**: usa `bash install.sh` invece di
  `./install.sh`. Alcuni metodi di copia perdono il permesso di esecuzione.
- **Il download di Chromium fallisce** (proxy, rete lenta): rilancia
  `bash install.sh`. È idempotente.

### 4. Verificare

```bash
claude mcp get web-vision        # deve dire: Status: ✔ Connected
```

Poi apri una **nuova** sessione di Claude Code: quelle già aperte non vedono i
server aggiunti dopo. Dentro la sessione, `/mcp` elenca `web-vision` con i suoi
5 tool. Questa prova dimostra che il modello **vede** l'immagine e non legge
del testo:

```bash
claude -p 'Usa browser_open su data:text/html,<canvas id=c width=600 height=300></canvas><script>const x=c.getContext("2d");x.font="bold 90px sans-serif";x.fillText("GIRAFFA",60,190)</script> e dimmi che parola vedi' \
  --allowedTools mcp__web-vision__browser_open
```

La parola è disegnata su un canvas: non sta nel DOM né in nessun testo, quindi
il modello può rispondere «GIRAFFA» solo guardando lo screenshot.

---

## Come si usa

Non serve chiamare i tool a mano: basta chiedere a Claude Code. Per esempio:

> Apri http://localhost:5173, fai il login con l'utente di test, crea un
> ordine con due prodotti e verifica che compaia nella lista. Segnalami ogni
> errore che vedi.

> Ho cambiato il componente `Cart.tsx`: controlla che il totale si aggiorni
> quando cambio la quantità, e che non ci siano errori in console.

> Su https://staging.miaazienda.it prova tutti i campi del form di
> registrazione con valori sbagliati e dimmi quali messaggi di errore
> mancano.

Funziona con **qualsiasi frontend raggiungibile dal computer dove gira Claude
Code**:

- `localhost` (il tuo `npm run dev`);
- un IP della rete locale (`http://192.168.1.20:5173`);
- un nome interno, uno staging o un sito pubblico;
- **HTTPS con certificato autofirmato** o di una CA aziendale: è accettato.

Un URL senza `http://` (`localhost:5173`) viene completato da solo.

### Permessi

Claude Code chiede conferma prima di usare un tool la prima volta. Per non
confermare ogni volta i tool di web-vision, rispondi «sì, sempre» alla prima
richiesta, oppure aggiungi questa riga a `/permissions`:

```
mcp__web-vision__*
```

Su una rete aziendale valuta se lasciare la conferma attiva: il modello può
aprire qualsiasi indirizzo raggiungibile dal tuo computer, compresi pannelli
interni, e operarci con il tuo stesso accesso.

Se vuoi che dopo una modifica il modello controlli anche i tipi TypeScript, e
non solo la pagina, consenti quel comando, per esempio `Bash(npx tsc:*)`.

### Dati sul server

Il modello testa i flussi **attraverso l'interfaccia**, come un utente: se crei
un ordine con il form, l'ordine viene creato davvero, come se l'avessi fatto
tu. Su uno staging condiviso tienilo presente e dillo nella richiesta («non
cancellare dati esistenti», «usa il cliente di test»).

Se invece il modello prova a scrivere dati sul server con uno script
(`fetch` dentro `browser_eval`), scavalcando l'interfaccia, il tool glielo
sconsiglia e, se succede comunque, **lo segnala nel resoconto** con il
dettaglio delle richieste («this eval sent POST /api/orders → 201»).

### Per chi sviluppa in React

Verificato su React 19 + Vite + react-router, con StrictMode:

- **Form controllati**: `type`, `select`, `check` e `set_value` cambiano lo
  **stato React**, non solo quello che si vede. Il tool dice al modello di non
  scrivere mai `.value =` con `browser_eval`: lo screenshot mostrerebbe il
  valore nuovo mentre lo stato React resta quello vecchio, e il form
  invierebbe altri dati.
- **HMR di Vite**: dopo una modifica al sorgente, `browser_look` mostra già la
  versione nuova e **conserva lo stato** (contatori, campi compilati).
- **React Router**: la navigazione lato client e `back`/`forward` funzionano;
  l'URL riportato è quello della route attuale.
- **Errori**:
  - quelli di runtime arrivano con messaggio e stack;
  - quelli catturati da un error boundary sono contati come problemi;
  - l'**overlay di errore di Vite** viene letto e riportato come testo, e il
    tool dice quando l'overlay copre la pagina e blocca i click.
- **Numeri di riga**: negli stack di un dev server si riferiscono al codice
  già trasformato (JSX compilato), non al tuo file. Il tool lo dice al modello,
  così cerca il punto per nome di funzione o di componente.
- Il doppio log di StrictMode e il messaggio «Download the React DevTools» non
  vengono contati come problemi.

---

## Configurazione

`config.json` sta nella cartella e viene letto all'avvio di ogni sessione di
Claude Code:

| Chiave | Default | Significato |
|---|---|---|
| `defaultUrl` | `http://127.0.0.1:5173` | pagina aperta quando il modello usa un tool senza URL (5173 è la porta di Vite) |
| `autoStart` | `false` | se `defaultUrl` è locale e spento, lancia `npm run dev` (o `start`/`serve`) nella cartella del progetto |
| `idleCloseMinutes` | `10` | chiude Chromium dopo N minuti senza chiamate (`0` = mai) |
| `viewport` | `1280×720` | dimensione della finestra |
| `jpegQuality` | `75` | qualità degli screenshot. Più alta = più token di contesto |
| `ignoreHTTPSErrors` | `true` | accetta certificati autofirmati e di CA interne |
| `keepLogin` | `true` | conserva cookie, localStorage e IndexedDB fra le sessioni (vedi sotto) |
| `storageStatePath` | `~/.cache/web-vision/storage-state.json` | dove sta il login salvato |
| `dialogs` | `"accept"` | `alert`/`confirm`/`prompt`: `"accept"` o `"dismiss"`. Vengono sempre riportati |
| `httpCredentials` | `null` | per i siti con login HTTP (la finestrella del browser): `{"username": "…", "password": "…", "origin": "https://staging.x.it"}` |
| `extraHTTPHeaders` | `null` | header da aggiungere alle richieste, es. `{"X-Env": "staging"}` |
| `extraHTTPHeadersHosts` | `null` | se impostato (es. `["staging.x.it"]`), gli header extra vanno **solo** a quei siti; altrimenti a tutti |
| `actionTimeoutMs` | `5000` | quanto aspettare un elemento prima di dichiarare fallita un'azione (un selettore che non corrisponde a niente fallisce dopo questo tempo; un elemento che c'è ma resta nascosto dopo 1,5 s). Un `timeout_ms` passato alla singola azione comanda entrambe le attese |
| `navigationTimeoutMs` | `45000` | quanto aspettare il caricamento di una pagina. **Tienilo sotto ~55 s**: il client MCP di Claude Code abbandona da solo a 60 s, e alzandolo oltre quel limite il messaggio onesto («il server non ha risposto») non arriverebbe mai al modello |
| `evalTimeoutMs` | `30000` | durata massima di un `browser_eval` |
| `maxFullPageHeight` | `3000` | oltre questa altezza `full_page` cattura solo la parte alta: un'immagine più alta arriverebbe al modello rimpicciolita fino a essere illeggibile |
| `executablePath` | *(auto)* | un Chromium specifico al posto di quello di Playwright |
| `launchArgs` | *(per sistema)* | flag di Chromium. Su Linux WebGL passa da SwiftShader (CPU); su Mac usa la GPU da solo |

Dopo aver cambiato `config.json` apri una nuova sessione di Claude Code: le
sessioni già aperte usano la configurazione che hanno letto all'avvio.

---

## Cosa vede il modello, e quando

Questa sezione è importante: dice quando lo screenshot mostra il codice **di
adesso** e quando potrebbe mostrarne una versione vecchia.

### Aprire e guardare non sono la stessa cosa

- **`browser_open`** carica sempre la versione attuale. Se la pagina è già
  aperta, la ricarica, e il suo stato (campi compilati, click) riparte da zero.
- **`browser_look`** guarda la pagina **così com'è**, senza ricaricarla. È ciò
  che permette di fare un'azione e poi guardarne il risultato.

Le conseguenze dipendono da come è servito il progetto:

| Il tuo progetto è servito da… | Dopo una modifica ai file, `browser_look` mostra… |
|---|---|
| un dev server **con hot reload** (Vite, Next, webpack…) | ✅ la versione nuova: il dev server ha già aggiornato la pagina, e lo stato resta |
| un server **statico** o un **backend** senza hot reload | ⚠️ **la versione vecchia**, finché non si ricarica con `reload: true` o `browser_open` |

Il modello lo sa: il server glielo scrive nelle istruzioni, e quando guarda di
nuovo una URL già aperta glielo ricorda nella risposta. Nei test non ha mai
dimenticato il reload sul server statico. Su Vite, in un caso, ne ha fatto uno
superfluo dopo aver corretto un errore di compilazione: costa solo lo stato
della pagina.

### La cache del browser è spenta

Questo problema è stato **misurato**. Con un server che manda
`Cache-Control: max-age` sugli asset (lo fanno molti backend) e la cache del
browser accesa, dopo una modifica e un reload si vedeva l'**HTML nuovo con CSS
e JS vecchi**: una pagina che non corrisponde a nessuna versione del codice.
Per questo il server spegne la cache HTTP (come DevTools con «Disable cache»)
e blocca i service worker, che altrimenti servirebbero i file dalla propria
cache.

### Dopo un'azione, il tool aspetta che la pagina reagisca

Prima dello screenshot il tool aspetta:

- che le **transizioni CSS** finiscano, altrimenti una barra viene fotografata
  a metà animazione;
- che il **DOM** stia fermo per un attimo, così i toast e i messaggi che
  compaiono poco dopo un click finiscono nell'immagine;
- che le richieste di rete in corso si chiudano.

Le animazioni infinite (spinner, canvas animati) non si aspettano.
Un'app può anche segnalare da sola quando è pronta con
`window.__renderReady = true`.

### Rete: niente falsi allarmi

- Una richiesta riuscita viene registrata con il suo stato (`GET 200 …`) in
  `browser_console`.
- Una richiesta che il browser abbandona dopo che il server ha già risposto
  (una fetch di cui la pagina non legge la risposta, come fanno analytics e
  log) **non** viene segnalata come errore. Prima veniva segnalata, e i
  modelli concludevano «la richiesta fallisce» quando invece era riuscita.
- I fallimenti veri (server spento, errori 4xx/5xx) restano fra i problemi.

### Il login resta

Con `keepLogin` attivo (il default), cookie, localStorage e IndexedDB dei siti
visitati vengono salvati in `~/.cache/web-vision/storage-state.json`. Quindi:

- un frontend con autenticazione richiede il login **una volta**, non a ogni
  sessione;
- il login sopravvive anche alla chiusura per inattività;
- più sessioni di Claude Code aperte insieme non si cancellano il login a
  vicenda: ognuna scrive solo ciò che ha cambiato.

Il file contiene **cookie di sessione veri**. Nasce con permessi `600`
(leggibile solo da te) e non va condiviso. Per uscire da tutto basta
cancellarlo. Il `sessionStorage` non viene conservato, come in un browser vero
alla chiusura della scheda.

### Pagine bloccate

Una pagina con JavaScript che non termina (un ciclo infinito) bloccherebbe il
browser. Il tool se ne accorge in pochi secondi, lo dice e riavvia Chromium:

- blocco durante un'**azione** (un click che entra in un ciclo): ~8 s;
- blocco durante il **caricamento** (il ciclo è nella pagina stessa): ~7 s. Il
  tool aspetta prima che l'HTML sia arrivato, poi che la pagina risponda: un
  server lento non viene scambiato per una pagina bloccata, perché finché la
  risposta non è arrivata il silenzio è del server.

Se la pagina si blocca proprio mentre la si sta aprendo, il tool **non la
riapre**: la chiamata successiva riparte dall'URL di default (`defaultUrl`),
invece di riprodurre il blocco a ogni chiamata.

### Chromium si chiude quando non serve

Dopo 10 minuti senza chiamate (`idleCloseMinutes`) Chromium si chiude e libera
CPU e memoria: una pagina che anima un canvas, renderizzata su CPU, occupa
core anche quando nessuno la guarda. Alla chiamata successiva Chromium riparte
e **torna all'ultima pagina visitata**, anche se ci si era arrivati con un
click. Restano il login e la pagina; si perde lo stato *dentro* la pagina
(campi compilati, scroll). Chromium si chiude anche quando si chiude Claude
Code.

### Gli screenshot occupano contesto

Ogni screenshot entra nella conversazione: circa 1.000–1.500 token a
1280×720. Nelle sessioni lunghe con molte azioni si arriva prima alla
compattazione. Se ti pesa, abbassa `jpegQuality` o `viewport`.

---

## Limiti noti

- **Login con 2FA, SSO esterni o CAPTCHA**: il modello non li può fare da solo.
  Fallo tu una volta, poi il login resta salvato. Puoi anche importare un file
  di stato in formato Playwright in `storageStatePath`.
- **iframe**: si opera dentro un iframe alla volta, indicandolo con `frame`.
- **Upload**: i file da caricare devono stare sul computer dove gira Claude
  Code.
- **Un solo browser per sessione**: le chiamate vengono eseguite una alla
  volta, nell'ordine in cui arrivano.
- **`browser_eval`** restituisce il valore dell'ultima espressione. Se il
  codice usa `await` e finisce con un `if` o un ciclo, serve un `return`
  esplicito.
- **Pagine che cambiano da sole** (orologi, countdown): dopo ogni azione il
  tool aspetta al massimo 0,6 s che la pagina si assesti, quindi un effetto
  più lento può finire nello screenshot successivo.
- **Risposte che si interrompono a metà**: se il server manda l'HTML e poi non
  lo finisce mai, il tool aspetta il tempo di `navigationTimeoutMs` e poi dice
  che il server non ha risposto in tempo — non lo scambia per una pagina
  congelata.
- **Navigazioni fallite contate una volta**: quando una pagina non si apre
  (host inesistente, porta chiusa), il browser segnala lo stesso guasto **due
  volte** (riprova a mostrare la propria pagina d'errore). Il tool tiene una
  voce sola, quindi non lo vedi comparire due volte in due sguardi diversi.
  Un secondo tentativo vero, invece, parte da una navigazione nuova e si vede
  normalmente: non viene scambiato per una ripetizione. Il riconoscimento si basa
  sul conteggio delle navigazioni, che è unico per la sessione: se fra i due
  annunci della stessa navigazione fallita ne parte una **in un'altra scheda**,
  la ripetizione può ricomparire. Non è stato riprodotto in prova; nel dubbio si
  vede una riga in più, mai una in meno.
- **Risorse che falliscono due volte**: due `fetch` verso un host inesistente
  danno **due** voci, ma due `<img src>` con la **stessa** URL ne danno **una**:
  è Chromium che deduplica l'immagine e annuncia un guasto solo. Il tool riporta
  quello che il browser ha davvero emesso.
- **`browser_look {reload:true}` dopo un `browser_open` fallito**: se prima non
  eri su nessuna pagina, la ricarica va all'URL di partenza, non alla pagina
  d'errore (riprovare la stessa URL morta fallirebbe di nuovo). L'URL che ottieni
  è scritto nella risposta.
- **`full_page` su una pagina alta**: cattura solo la parte alta (vedi
  `maxFullPageHeight`) e, se la pagina è più larga della finestra, anche solo la
  parte sinistra — il messaggio te lo dice.

---

## Usarlo da opencode

Questo tool è nato come plugin di **opencode**; ora la parte browser è questo server, e in
opencode i tool arrivano da qui. Servono due pezzi.

**1. Il server**, registrato in `~/.config/opencode/opencode.json`:

```json
"mcp": {
  "web-vision": {
    "type": "local",
    "command": ["node", "/percorso/di/web-vision/server.mjs"],
    "enabled": true,
    "environment": {
      "WEB_VISION_CONFIG": "/home/tu/.config/opencode/web-vision.json"
    }
  }
}
```

Scrivi il percorso di `node` per esteso se opencode non lo trova nel `PATH` (con `nvm` non
c'è: meglio `/home/tu/.nvm/versions/node/vXX/bin/node`). `WEB_VISION_CONFIG` è la config di
questo server: là dentro stanno `autoStart`, `defaultUrl`, `viewport`, i timeout e
`maxFullPageHeight`. In opencode i tool si chiamano col nome del server davanti:
`web-vision_browser_look`, `web-vision_browser_open`, `web-vision_browser_act`,
`web-vision_browser_console`, `web-vision_browser_eval`.

**2. Un plugin di due hook soli**, `~/.config/opencode/plugin/browser-vision-hooks.ts`: un
server MCP non può toccare i messaggi di opencode, quindi quello che resta è solo ciò che
un MCP non può fare:

- dopo `edit`/`write`/`patch` aggiunge al risultato del tool
  `[the running page is now stale — call web-vision_browser_look …]`: è ciò che rende la
  pagina appena cambiata un motivo per guardarla;
- tiene solo gli screenshot degli ultimi `keepRecentImages` messaggi (config
  `~/.config/opencode/browser-vision.json`), così le immagini vecchie non mangiano contesto.
  Attenzione: gli screenshot di un tool **non** sono parti di tipo `file`, stanno in
  `part.state.attachments` della parte `tool` — un filtro che cerca solo `p.type === "file"`
  non trova niente e non taglia nulla.

Il vecchio plugin completo (`browser-vision.ts.off`) non serve più: teneva Chromium e i tool,
ma senza cache HTTP spenta, senza `reload`, senza `timeout_ms`, senza antigelo e contando due
volte i guasti di navigazione. Non cancellarlo finché non sei sicuro: basta rinominarlo
`.ts` per riaverlo — e allora togli il blocco `mcp`, se no i tool sono doppi.

Rispetto al plugin si perde solo il `prewarm` (Chromium e la pagina di default aperti
all'avvio di opencode): il primo sguardo costa 1–2 s in più.

---

## Rimuoverlo

```bash
cd ~/web_vision_claude_code          # o dove l'hai messo
bash uninstall.sh                    # lo toglie da Claude Code, i file restano
bash uninstall.sh --purge            # lo toglie e cancella i suoi file e il login salvato
```

`--purge` cancella **solo i file di web-vision**, per nome, dopo aver
controllato che la cartella sia davvero la sua. Se nella cartella hai messo
altri file, quelli restano e la cartella non viene tolta.

Se la cartella non c'è più, a mano:

```bash
claude mcp remove web-vision -s user
rm -rf ~/web_vision_claude_code ~/.cache/web-vision
```

Le sessioni di Claude Code già aperte tengono vivo il server finché non le
chiudi.

**Chromium non viene cancellato**, perché può servire ad altri strumenti. Se
sei sicuro che non serve a niente:

```bash
rm -rf ~/Library/Caches/ms-playwright     # Mac
rm -rf ~/.cache/ms-playwright             # Linux
```

---

## Se non funziona

```bash
claude mcp get web-vision                    # stato della registrazione
node ~/web_vision_claude_code/selftest.mjs   # prova il server da solo, fuori da Claude Code
```

Su Linux, se il selftest parla di librerie mancanti (`libnss3`, `libgbm`…):

```bash
sudo node ~/web_vision_claude_code/node_modules/playwright-core/cli.js install-deps chromium
```

Il server scrive i suoi messaggi su stderr: per vederli avvia Claude Code con
`claude --debug`.

Messaggi frequenti:

| Il modello riceve… | Significa |
|---|---|
| `ERR_CONNECTION_REFUSED … Nothing is listening` | il server non è avviato o la porta è sbagliata. Se il frontend è su un altro computer, Vite va avviato con `--host` |
| `ERR_NAME_NOT_RESOLVED` | il nome non si risolve da questo computer (VPN spenta?) |
| `ERR_CONNECTION_RESET / CLOSED` | probabilmente `http://` su una porta https o viceversa |
| `ERR_INVALID_AUTH_CREDENTIALS` | il sito chiede un login HTTP: imposta `httpCredentials` |
| `NOT VISIBLE … hover its parent first` | l'elemento c'è ma è nascosto (spesso compare al passaggio del mouse) |
| `covered by the Vite error overlay` | c'è un errore di compilazione: va corretto il sorgente |
| `INSIDE AN IFRAME: repeat the action with frame: …` | ripeti l'azione con il parametro `frame` indicato |
| `the page stopped responding` | JavaScript bloccato nella pagina: Chromium è stato riavviato |
