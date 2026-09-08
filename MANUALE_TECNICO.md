# Mamma Diurna — Manuale tecnico

Documento ad uso di Giovanni Ugo Altieri, sviluppatore e manutentore dell'app. Descrive architettura, funzionamento interno e procedure di installazione/deploy.

> Per il manuale rivolto alle mamme diurne (uso quotidiano dell'app) vedi `MANUALE_UTENTE.md`.

---

## 1. Panoramica architetturale

Mamma Diurna è composta da tre parti indipendenti, tutte serverless (nessun database né backend da amministrare):

```
┌─────────────────────┐      ┌──────────────────────┐      ┌───────────────────────┐
│   index.html (PWA)  │ ───► │  worker.js            │ ───► │  afdsonline.famiglie-  │
│   GitHub Pages       │      │  Cloudflare Worker    │      │  diurne.ch (API AFDS)  │
│   (statico)           │      │  (proxy + licenze)    │      └───────────────────────┘
└─────────────────────┘      └──────────┬────────────┘
        │                               │
        │                               ▼
        │                     ┌───────────────────────┐
        │                     │  Google Sheets         │
        │                     │  (tabella licenze)      │
        │                     └───────────────────────┘
        ▼
  ricarica.html (pagamento licenza, statico, stesso hosting)
```

- **`index.html`** — l'intera app: HTML + CSS + JS in un unico file, nessuna build, nessuna dipendenza npm lato client. Gira interamente nel browser del telefono; i dati delle presenze restano su `localStorage` finché non vengono caricati sul portale.
- **`worker.js`** — un Cloudflare Worker che fa da proxy verso l'API del portale AFDS (per evitare problemi di CORS e per non esporre endpoint/segreti direttamente al client) e da gateway per il controllo della licenza d'uso, leggendo una tabella su Google Sheets.
- **`ricarica.html`** — pagina statica con le istruzioni di pagamento (TWINT/IBAN), raggiungibile dai popup di scadenza licenza.

Perché questa architettura: zero costi fissi (GitHub Pages e Cloudflare Workers hanno piani gratuiti ampiamente sufficienti per questo volume d'uso), zero manutenzione di server/DB, deploy immediato con un semplice `git push`.

---

## 2. Frontend — `index.html`

### 2.1 Struttura del file

Un solo file da ~1200 righe: `<style>` inline in testa, markup HTML, `<script>` inline in coda. Non c'è bundler/transpiler: si edita e si pusha direttamente.

Unica eccezione: `xlsx-js-style.min.js` (libreria SheetJS con supporto stili, licenza Apache 2.0), vendorizzata come file separato e caricata con `<script src="xlsx-js-style.min.js">` prima dello script principale, usata da `exportXLS()` per generare file `.xlsx` con celle unite/centrate/bordate. Scelta deliberata di non usare un CDN esterno, per non introdurre una dipendenza di rete quando l'app viene usata con connessione scarsa (vedi commit che l'ha introdotta per il ragionamento completo).

### 2.2 Stato e persistenza (`localStorage`)

Tutto lo stato applicativo vive in `localStorage` del browser, non su un server. Chiavi principali:

| Chiave | Contenuto |
|---|---|
| `afds_settings` | credenziali AFDS, nome, timeout, soglia arrotondamento (vedi CLAUDE.md per lo schema) |
| `afds_all_logs` | oggetto `{ "YYYY-MM-DD": [entry, ...] }` — tutte le timbrature inserite, per data |
| `afds_children` | cache della lista bambini scaricata dal portale |
| `afds_children_date` | data dell'ultimo refresh della lista bambini (per il refresh giornaliero automatico) |
| `afds_family_rc` | `familyRecordcode` della mamma diurna, cache per evitare una chiamata extra ad ogni login |
| `lic_status` | ultimo stato licenza noto (`ok`/`expiring`/`grace`/`blocked`) |
| `lic_shown_YYYY-MM-DD` | flag "popup licenza già mostrato" per quella data selezionata (vedi §2.5) |
| `lic_check_date` | data dell'ultimo popup licenza mostrato all'avvio app |
| `app_ver` | ultima versione app nota, per il banner di aggiornamento |

Una singola voce di `afds_all_logs[data]` (un "turno") ha questa forma:

```json
{
  "recordcode": "12345",
  "ts": "2026-06-14T08:00:00.000Z",
  "timeIn": "08:00",
  "timeOut": "17:00",
  "chkPattuite": false,
  "chkMalattia": false,
  "chkColazione": true,
  "chkPranzo": true,
  "chkMerenda": false,
  "chkCena": false,
  "synced": false
}
```

`synced` distingue i turni già caricati sul portale da quelli ancora in sospeso — è la base del meccanismo di sync incrementale (§2.4).

### 2.3 Flusso di registrazione presenza

1. Tap su un bambino → `openModal(recordcode)`
2. Check licenza lato client (nessuna credenziale → toast e redirect Impostazioni) e lato worker (`POST /auth/check`, vedi §3.3 per la logica completa)
3. Se il check passa, si apre il pannello (`_doOpenModal`) precompilato con l'ora corrente come entrata
4. L'utente inserisce entrata/uscita, spunta pasti/note; `updateTotale()` calcola il totale ore in tempo reale
5. **Arrotondamento automatico** (`roundedTimes`): se la durata non è già multipla di 15', l'algoritmo cerca la combinazione entrata/uscita arrotondata a 15' che minimizza lo scarto complessivo dagli orari reali inseriti. La soglia (default 6 minuti) è configurabile in Impostazioni avanzate.
6. `saveModal()` scrive il turno in `log` (l'array del giorno selezionato) e lo persiste in `afds_all_logs`

### 2.4 Sincronizzazione col portale AFDS (`startSync`)

Dalla scheda "Carica":

1. Login al portale (`WebLoginJwt`) → ottiene `session` + `accessToken` JWT
2. Ricarica la lista bambini aggiornata (`fetchChildren`)
3. Per ogni turno non ancora sincronizzato nel periodo selezionato:
   - Recupera (con cache in `_svcCache`) i codici servizio del contratto del bambino via `GetCareItemServices`, mappando i codici AFDS (`01MD`=ore normali, `01MDA`=pattuite, `01MDM`=malattia, `1COL`/`2PRA`/`3MER`/`4CEN`=pasti)
   - Se ci sono orari, invia un record ore (`UpdateCareRegisterData`) con `subjectPercent` 50% in caso di malattia
   - Per ogni pasto spuntato, invia un record separato (`value:1`, orari a zero)
   - Marca l'entry come `synced:true` solo dopo l'invio riuscito
4. Ad ogni sync il token/sessione vengono azzerati e rifatti da zero, per evitare problemi di scadenza JWT (durata ~1h)

Solo i turni con `synced:false` nel periodo selezionato vengono effettivamente inviati (`unsync` in `startSync`). Se nel periodo ci sono anche turni già `synced:true`, un toast avvisa l'utente prima di procedere che non verranno reinviati.

`buildSyncPreview()` (funzione chiamata ad ogni cambio dei campi data, e all'apertura della scheda "Carica") mostra invece **tutti** i turni del periodo selezionato, non solo quelli da inviare: quelli con `synced:true` sono renderizzati con classe CSS `sync-item synced` (in grigio, icona ✓) e non sono cliccabili; quando ce n'è almeno uno, un banner (`.sync-warn-banner`) spiega che non verranno riproposti e che vanno cancellati manualmente dal portale per essere corretti. Questa è pura UI: `startSync` non dipende da `buildSyncPreview` e la logica di invio resta invariata.

`exportXLS()` esporta in formato `.xlsx` (libreria `xlsx-js-style.min.js`) le presenze del periodo selezionato in "Periodo da caricare" (campi `syncDateFrom`/`syncDateTo`): un bambino per riga, colonna finale con il totale ore per bambino e riga finale con il totale complessivo del periodo. A differenza di `startSync`/`buildSyncPreview`, qui **tutti i giorni** del periodo compaiono come colonne (anche quelli senza nessuna presenza, es. un weekend), non solo quelli con `allLogs` popolato — l'elenco date è generato iterando calendario da `from` a `to` inclusi, non filtrando le chiavi di `allLogs`. La larghezza di ciascun blocco data (2 colonne = 1 turno entrata/uscita, 4 = 2 turni, ecc.) è calcolata singolarmente per ogni data in base al numero massimo di turni che un bambino qualsiasi ha avuto quel giorno specifico (`sessioniPerData`), non un valore fisso uguale per tutte le date.

### 2.5 Calendario, date, timeout

- Calendario custom (non `<input type="date">` nativo) per lo stile dell'app, con navigazione a frecce e swipe touch
- `activeDate` è la data "in vista" (può differire da oggi); quando si sceglie una data passata/futura appare un banner giallo e parte un countdown (`timeout`, default 180s) che riporta automaticamente a oggi in caso di inattività — pensato per evitare che si registrino per sbaglio presenze sulla data sbagliata se il telefono resta aperto
- Swipe orizzontale sulla lista bambini cambia giorno di ±1

### 2.6 PWA e aggiornamenti

- `manifest.json` definisce icone, `start_url`, modalità `standalone`
- Nessun service worker: l'app si affida al banner di aggiornamento manuale. Ad ogni avvio, `checkAppVersion()` legge `version.json` (con cache-busting `?t=timestamp`) e confronta con `app_ver` salvato; se diverso, mostra il banner "Nuova versione disponibile" che forza un reload con querystring nuova
- **Per questo va aggiornato `version.json` ad ogni deploy** (vedi CLAUDE.md e §6)

---

## 3. Backend — `worker.js` (Cloudflare Worker)

### 3.1 Perché serve un Worker

Il portale AFDS non espone CORS per chiamate dirette da un dominio esterno, e le credenziali/segreti (Google API key, OAuth secret) non possono stare nel codice client (pubblico su GitHub Pages). Il Worker fa da intermediario:

- Le password AFDS **non transitano mai dal Worker in chiaro verso uno storage**: vengono inoltrate 1:1 al login AFDS e restano solo su `localStorage` del client.
- I segreti Google (per il check licenza) vivono solo lato Worker, mai nel client.

### 3.2 Routing

| Path | Metodo | Scopo |
|---|---|---|
| `/` | GET | health check, ritorna versione/feature del worker |
| `/auth/check` | POST | verifica stato licenza per uno username (§3.3) |
| `/auth/token` | POST | scambio PKCE per OAuth Google — *presente nel codice ma non risulta invocato dal frontend attuale; verificare se ancora necessario prima di rimuoverlo* |
| `/api/<endpoint>` | POST | proxy generico verso l'API AFDS, con mapping in `ENDPOINT_MAP` |

`ENDPOINT_MAP` copre: `WebLoginJwt`, `GetUserFirmPreference`, `GetCareRegisters(Grouped)`, `GetCareActivePersonContracts`, `GetCareItemServices`, `UpdateCareRegisterData`, `DeleteCareRegisterData`. Il proxy inoltra il body così com'è, aggiunge header `Origin`/`Referer`/`User-Agent` che imitano il portale mobile, e ritorna la risposta AFDS invariata (con header CORS aggiunti da `cors()`).

### 3.3 Logica di licenza (dettaglio completo in `CLAUDE.md`)

`checkLicenza(username, sheetsApiKey)` legge la tabella Google Sheets (`Foglio1!A2:E100`) del foglio con ID `14DhCWCYlte2zhQk74_LG-IovR41W47TajWZBsCdhXE0`:

| Colonna | Contenuto |
|---|---|
| A | Username |
| B | Nome completo (non usato nel check) |
| C | Data avvio licenza (`dataInizio`) |
| D | Data scadenza |
| E | Note (non usato) |

Costanti: `GRACE_DAYS = 3` (giorni di tolleranza dopo la scadenza), `WARN_DAYS = 10` (giorni di preavviso prima della scadenza).

Stati possibili restituiti: `ok`, `expiring` (in scadenza entro `WARN_DAYS`), `grace` (scaduta ma entro `GRACE_DAYS`, o utente non presente in tabella = periodo di prova), `blocked` (scaduta oltre la grace period). Se lo username non è in tabella, l'utente è trattato come in prova (`grace`, `GRACE_DAYS` giorni).

Se la chiamata a Google Sheets fallisce (rete, quota, ecc.), il worker **fallisce aperto**: ritorna `status: 'ok'` per non bloccare l'utente per un problema tecnico esterno.

Il frontend applica poi la logica di visualizzazione (popup una tantum per data, blocco vs. grazia) descritta in `CLAUDE.md` §"Logica licenza".

### 3.4 Segreti

Configurati in Cloudflare (mai nel codice sorgente):

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — per il flusso OAuth PKCE (`/auth/token`)
- `SHEETS_API_KEY` — API key Google con accesso in lettura al foglio licenze

---

## 4. `ricarica.html` — pagina di pagamento licenza

Pagina statica indipendente, linkata dai popup di scadenza/blocco licenza (`window.location.href='ricarica.html'`). Mostra prezzi (fr. 6.—/mese singolo, fr. 4.—/mese da 3 mesi), dati di pagamento (TWINT, IBAN) e contatto. Nessuna logica dinamica lato server: è un promemoria testuale, il rinnovo effettivo avviene manualmente aggiornando la riga dell'utente nel Google Sheet (§7).

---

## 5. Sicurezza

- Le credenziali AFDS (`afdsUser`/`afdsPwd`) sono salvate **in chiaro in `localStorage`** sul dispositivo dell'utente — mai su un server. Rischio accettato: è lo stesso modello di un browser che ricorda una password, e l'app è mono-utente/mono-dispositivo per costruzione.
- Il Worker non logga né persiste password: le inoltra e basta.
- CORS aperto a `*` sul Worker (`Access-Control-Allow-Origin: *`) — accettabile perché gli endpoint richiedono comunque credenziali AFDS valide o non espongono dati sensibili senza autenticazione a monte.
- La API key Google Sheets ha (dovrebbe avere) permessi di sola lettura sul foglio licenze.

---

## 6. Ambiente di sviluppo locale

Node.js non è installato di sistema; si usa una versione estratta in `/tmp` (volatile, va riscaricata se `/tmp` viene svuotato):

```bash
export PATH="/tmp/node-v22.14.0-linux-x64/bin:$PATH"
```

Se mancante:

```bash
curl -s https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz -o /tmp/node22.tar.xz
tar -xf /tmp/node22.tar.xz -C /tmp
export PATH="/tmp/node-v22.14.0-linux-x64/bin:$PATH"
npm install -g wrangler
```

Non serve altro: niente `npm install` di progetto, niente `package.json` — `index.html` si apre e basta anche solo con un browser (per test locali rapidi, alcune chiamate al Worker funzionano comunque perché puntano a un URL assoluto).

---

## 7. Deploy

### 7.1 App (GitHub Pages)

- Repo: `github.com/mammadiurna-app/app`, branch `master`
- URL pubblico: `https://mammadiurna-app.github.io/app/`
- Push key: `~/.ssh/id_ed25519`, configurata come deploy key con write access sul repo
- **Prima di ogni push**, aggiornare `version.json` con una stringa univoca (es. `2026-06-21-2`) — altrimenti gli utenti già installati non vedranno il banner di aggiornamento
- Deploy = semplice `git push`; GitHub Pages rigenera automaticamente

### 7.2 Worker (Cloudflare)

```bash
export PATH="/tmp/node-v22.14.0-linux-x64/bin:$PATH"
wrangler deploy
```

URL pubblico: `https://afds-proxy.gianugo-altieri.workers.dev`. Config in `wrangler.toml` (nome worker `afds-proxy`, entry point `worker.js`).

Per aggiornare un segreto:

```bash
echo "VALORE" | wrangler secret put NOME_SECRET
```

**Dashboard Cloudflare** (per login, log, metriche, gestione segreti da interfaccia grafica):
- Login: https://dash.cloudflare.com/login
- Pagina del worker `afds-proxy`: https://dash.cloudflare.com/277130ccc28983671740c4c488d4be07/workers/services/view/afds-proxy/production

  Utente: `___________`
  Password: `___________`

---

## 8. Gestione operativa delle licenze

Per attivare/rinnovare un utente, modificare direttamente il Google Sheet (`14DhCWCYlte2zhQk74_LG-IovR41W47TajWZBsCdhXE0`, `Foglio1`):

**Link diretto al foglio**: https://docs.google.com/spreadsheets/d/14DhCWCYlte2zhQk74_LG-IovR41W47TajWZBsCdhXE0/edit

Account Google: `___________`
Password: `___________`

1. Trovare (o creare) la riga con lo username in colonna A (es. `l.altieri`)
2. Colonna C: data da cui la licenza è valida (`YYYY-MM-DD`) — se l'utente inserisce dati di mesi non pagati precedenti, il check `activeDate < dataInizio` li blocca
3. Colonna D: nuova data di scadenza (`YYYY-MM-DD`)
4. Nessun deploy necessario: il worker legge il foglio ad ogni richiesta, l'effetto è immediato

Non serve toccare né l'app né il Worker per la gestione ordinaria delle licenze.

---

## 9. Problemi noti e loro storia (troubleshooting)

Dalla cronologia dei commit, i punti più delicati del sistema in fase di sviluppo sono stati:

- **Recupero bambini dal portale**: `GetCareActivePersonContracts` richiede un `supervisorRecordcode` che in realtà è il `familyRecordcode` della mamma diurna, ottenibile solo tramite una chiamata preliminare a `GetUserFirmPreference` con i parametri esatti `{language, firmCode, username}`. Se questa chiamata cambia forma lato AFDS, il caricamento bambini si rompe silenziosamente (l'errore viene solo loggato in console, non mostrato all'utente) — punto da controllare per primo se "Ricarica lista bambini" non funziona.
- **JWT di sessione**: la sessione/token del portale dura circa un'ora. Il codice azzera sempre `_accessToken`/`_session` e la cache dei codici servizio (`_svcCache`) prima di ogni sync per evitare di riusare un token scaduto — se in futuro si aggiungono altre chiamate API, va mantenuta questa cautela o gestito un refresh esplicito.
- **Codici servizio per contratto**: i codici (`01MD`, `1COL`, ecc.) sono per-contratto e vanno recuperati con `GetCareItemServices` prima di ogni invio; sono cachati in memoria (`_svcCache`) ma **non persistiti**, quindi si perdono ad ogni ricarica pagina — non un bug, ma da tenere a mente se si ottimizza la sync.
- **Popup licenza duplicati**: la logica per mostrare l'avviso una sola volta al giorno è stata corretta più volte (bottoni "Chiudi" non dismissibili, mapping colonne del foglio errato) — se si tocca `checkLicenza`/`showLicPopup`/`openModal`, testare con attenzione tutti e 4 gli stati (`ok`/`expiring`/`grace`/`blocked`) più il caso `before` (data non coperta).
- **`/auth/token` (OAuth PKCE)**: presente nel worker ma nessun riferimento trovato nel frontend attuale (`index.html`) che lo invochi. Probabile residuo di un flusso di login alternativo mai attivato o rimosso dal client. Da verificare prima di eventuali refactor del worker.
- **`UpdateCareRegisterData` e duplicati**: nonostante il `recordcode` inviato sia sempre `''` (nessun update per chiave, solo creazione), un test dal vivo (2026-09-08, bambino/data di prova) ha confermato che **il portale stesso rifiuta lato server le sovrapposizioni** per lo stesso bambino: un secondo invio con lo stesso orario risponde `{"success":false,"message":"La registrazione indicata si sovrappone ad una già presente nel sistema per lo stesso bambino. Impossibile proseguire."}`. Non è quindi necessario un meccanismo di deduplica lato client per il caso di reinvio esatto — ma attenzione: il controllo è "si sovrappone", non "è identico", quindi anche una *correzione* di orario (es. stessa entrata, uscita diversa) verrebbe respinta come sovrapposizione finché il vecchio record non viene cancellato.
- **`UpdateCareRegisterData` non ritorna il `recordcode`** del record creato (risposta osservata: `{"success":true,"message":null}`), quindi l'app non può oggi risalire all'id di un proprio invio per poi correggerlo/cancellarlo.
- **`GetCareRegisters`/`GetCareRegistersGrouped`**: mappati in `ENDPOINT_MAP` ma mai usati dal frontend. Diversi tentativi di payload (per `contractRecordcode`, `itemRecordcode`, `personRecordcode`, `supervisorRecordcode`, con/senza `session`, con range di date diversi) restituiscono sempre `{"registers":[],"success":true}` — la forma corretta dei parametri non è nota. Senza questo endpoint funzionante, l'app non può elencare i record esistenti sul portale, il che blocca qualsiasi funzione di correzione/cancellazione automatica lato client.
- **`DeleteCareRegisterData` — formato confermato** (osservato via DevTools durante una cancellazione manuale sul portale, 2026-09-08): `POST .../WebApiCore/api/Care/DeleteCareRegisterData` con body `{"firmCode":"AFDS","language":1,"recordcode":"00376773"}`, risposta `200 OK`. Non è una vera `DELETE` HTTP (è un `POST`), nessuna sessione/utente nel body (l'autorizzazione è presumibilmente legata al token). Utile per una futura funzione di correzione, ma resta bloccata dal punto precedente (nessun modo noto per ottenere il `recordcode` da cancellare senza un `GetCareRegisters` funzionante).

---

*Ultimo aggiornamento di questo documento: da mantenere manualmente in sincronia col codice — non generato automaticamente.*
