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

```bash
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
| B | Data inizio (formato `YYYY-MM-DD`) — prima data coperta dalla licenza |
| C | Data scadenza (formato `YYYY-MM-DD`) |
| D | Attiva (`si` / `no`) |

Costanti nel worker: `GRACE_DAYS = 3`, `WARN_DAYS = 10`.

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
