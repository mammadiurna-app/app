# Mamma Diurna App

PWA per la gestione delle presenze bambini nel portale AFDS (Associazione Famiglie Diurne Svizzera).

## Struttura del progetto

| File | Scopo |
|------|-------|
| `index.html` | Tutta l'app (HTML + CSS + JS inline, single-page) |
| `worker.js` | Cloudflare Worker — proxy AFDS API + check licenza via Google Sheets |
| `manifest.json` | Manifest PWA |
| `icon-192.png` / `icon-512.png` | Icone PWA e favicon |
| `wrangler.toml` | Config deploy Cloudflare Workers |

## Deploy

### App (GitHub Pages)
- URL: `https://mammadiurna-app.github.io/app/`
- Repo: `github.com/mammadiurna-app/app` — branch `master`
- Push su `master` → GitHub Pages si aggiorna automaticamente

**Prima di ogni push**, aggiorna **sia** `version.json` **sia** la costante `APP_VERSION` in `index.html` (stessa stringa, es. `2026-06-14-2` per il secondo deploy del giorno) — l'app confronta il codice in esecuzione (`APP_VERSION`) con l'ultima pubblicata (`version.json`), non un flag salvato, quindi se disallineate il banner "Nuova versione disponibile" può comparire in loop anche a codice già aggiornato. L'app installata mostrerà il banner e si aggiorna al tocco.

```bash
# Aggiorna version.json e APP_VERSION in index.html, poi:
git push
```

### Worker Cloudflare
- URL: `https://afds-proxy.gianugo-altieri.workers.dev`
- Deploy:

```bash
export PATH="/tmp/node-v22.14.0-linux-x64/bin:$PATH"
wrangler deploy
```

- I segreti sono in Cloudflare (non nel codice). Per aggiornarli:

```bash
echo "VALORE" | wrangler secret put NOME_SECRET
```

Segreti configurati: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SHEETS_API_KEY`

## Logica licenza

### Flusso del check (in ordine)

Il check avviene ad ogni click su un bambino (`openModal` in `index.html`). I controlli sono eseguiti nell'ordine seguente:

1. **Nessuna credenziale** → toast + redirect a Impostazioni, modale bloccata (check lato client, senza chiamata al worker)
2. **Chiamata al worker** `POST /auth/check` con `{ username }` → risposta con `status`, più eventuali `dataInizio`, `allowedUntil`
3. **`activeDate < dataInizio`** → popup bloccante "Data non coperta", modale non si apre
4. **`status === 'blocked'`**:
   - `activeDate ≤ allowedUntil` → popup informativo, modale si apre (la data è coperta dalla grace period)
   - `activeDate > allowedUntil` → popup bloccante, modale non si apre
5. **`status === 'expiring'` o `'grace'`** → popup una volta per giorno di calendario (`activeDate`), poi modale si apre
6. **`status === 'ok'`** → modale si apre senza popup

### Campi restituiti dal worker

| Campo | Presente quando | Significato |
|-------|----------------|-------------|
| `status` | sempre | `ok` / `expiring` / `grace` / `blocked` |
| `dataInizio` | se colonna B compilata | Prima data coperta dalla licenza (`YYYY-MM-DD`) |
| `allowedUntil` | status `blocked` | Ultima data accessibile = `scadenza + GRACE_DAYS` |
| `daysLeft` | status `expiring` / `grace` | Giorni rimanenti |
| `message` | vari | Testo descrittivo per il popup |

### Ragione del limite inferiore (`dataInizio`)

Senza `dataInizio`, un utente che paga luglio potrebbe inserire dati di giugno senza pagare per quel mese. Il check `activeDate < dataInizio` blocca l'accesso a qualsiasi data precedente all'inizio della licenza pagata.

### Flag "popup già mostrato"

Salvato in localStorage con chiave `lic_shown_YYYY-MM-DD` basata sulla **data selezionata nel calendario** (`activeDate`), non sulla data di sistema. Evita che il popup `expiring`/`grace` esca più volte per la stessa data.

## Foglio licenze (Google Sheets)

ID foglio: `14DhCWCYlte2zhQk74_LG-IovR41W47TajWZBsCdhXE0`  
Foglio: `Foglio1`, colonne A2:E100

| Colonna | Contenuto |
|---------|-----------|
| A | Username (es. `l.altieri`) |
| B | Nome completo (es. `Liliana Altieri`) — non usato nel check |
| C | Data avvio (formato `YYYY-MM-DD`) — prima data coperta dalla licenza |
| D | Data scadenza (formato `YYYY-MM-DD`) |
| E | Note — non usato nel check |

Costanti nel worker: `GRACE_DAYS = 3`, `WARN_DAYS = 10`.

## Note e Agenda cronologica

Funzioni in `index.html`: `openAgendaOverlay` / `renderAgenda` (costanti `AG_*`), overlay `#agendaOverlay`, aperta dal box "timbrature ↗".

### Note e orari originali
- Textarea `#mNote` nella modale di timbratura (sotto Annulla/Salva), salvata in `entry.note`. Nel tab Bambini le note compaiono sotto le timbrature (`.log-note-row`); toccandole si apre la timbratura.
- `saveModal` salva `rawIn`/`rawOut` (orari non arrotondati) accanto a `timeIn`/`timeOut` (arrotondati). Portale, export e statistiche usano SOLO gli arrotondati; agenda e riapertura del form usano `rawIn||timeIn`.

### Agenda
- Layout a fasce da 1h (non lineare). Finestra default 07:00–18:00, estesa se servono eventi o ora corrente.
- Eventi di un'ora impilati (riga 24px, 40px con nota). Ingressi in nero, uscite verde scuro `#14532d`.
- **Sfondo per fascia oraria**: `rgba(0,0,0, min(n,3)*0.07)`, con `n` = massimo di bambini contemporaneamente presenti nell'ora. Zero bambini = bianco; 1–3 = grigio via via più scuro; oltre 3 resta al livello di 3. Un bambino con ingresso senza uscita conta come presente. (Valori più bassi, es. 0.04, sono quasi invisibili.)
- Ore vuote consecutive con stesso grigio (senza ora corrente) = una riga "··· N ore senza eventi ···"; mattina/pomeriggio senza bambini = blocco "Nessun bambino".
- Riga rossa dell'ora corrente (solo se la data è oggi), arrotondata ai 5', inserita in ordine cronologico; all'apertura lo scroll la centra.
- Un timer ogni 15s ridisegna e ricentra solo se ≥3' dall'ultimo update e ≥1' senza interazione; si ferma alla chiusura.
- Tocco su un evento → `openModal(rc, idx)` (la modale ha z-index 210, sopra l'agenda); dopo il salvataggio `refreshAgendaIfOpen()` ridisegna mantenendo lo scroll.

## Impostazioni app

Salvate in `localStorage` chiave `afds_settings`:

```json
{
  "afdsUser": "l.altieri",
  "afdsPwd": "...",
  "name": "Altieri",
  "timeout": 180,
  "roundThreshold": 6
}
```

- `name` si auto-popola dalla parte dopo il punto dello username
- `timeout`: secondi prima del rientro automatico alla data odierna
- `roundThreshold`: soglia (minuti) per arrotondamento a 15'

## Node.js / wrangler (ambiente locale)

Node.js non è installato di sistema. Versione estratta in `/tmp`:

```bash
export PATH="/tmp/node-v22.14.0-linux-x64/bin:$PATH"
```

Se `/tmp` è stato svuotato, ri-scaricare:

```bash
curl -s https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz -o /tmp/node22.tar.xz
tar -xf /tmp/node22.tar.xz -C /tmp
export PATH="/tmp/node-v22.14.0-linux-x64/bin:$PATH"
npm install -g wrangler
```

## SSH / GitHub

Chiave SSH configurata per il repo `mammadiurna-app/app` come deploy key con write access:  
`~/.ssh/id_ed25519` (aggiunta alle deploy keys del repo su GitHub).

Per fare push: `git push` (il remote è già configurato su `git@github.com:mammadiurna-app/app.git`).
