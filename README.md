# Rullo

App di allenamento sul rullo (web app, un solo file `index.html`), pubblicata su GitHub Pages:
https://pier-car.github.io/rullo/

- Mac, PC e Android: Chrome o Edge. iPhone: app gratuita Bluefy.
- Rullo FTMS (ERG e pendenza), cardio Bluetooth (COROS in “Trasmetti FC”), sensore di cadenza Bluetooth.
- Allenamenti del coach da CoachPeaking (.zwo), statistiche, file .FIT, invio facoltativo a Strava → CoachPeaking.

## Struttura

| Percorso | Cosa contiene |
|---|---|
| `index.html` | l’app compilata (non modificarla a mano: si rigenera) |
| `sw.js`, `manifest.webmanifest`, `icon-*.png` | funzionamento offline e installazione |
| `src/app.js` | interfaccia e logica dell’app (in cima: messaggio di benvenuto e configurazione Strava) |
| `src/core.js` | Bluetooth, allenamenti, statistiche, file FIT |
| `src/template.html` | pagina e stili |
| `src/build.py` | unisce i tre file in `index.html` |
| `src/strava-worker.js`, `src/STRAVA_SETUP.md` | servizio Cloudflare e guida per Strava (facoltativi) |
| `src/test/` | prove automatiche con rullo, cardio e sensore simulati |

## Modificare e provare

```
python3 src/build.py          # rigenera index.html
bash src/test/run.sh          # tutte le prove (serve Python con Playwright e Node.js)
```

Dopo una modifica alzare `APP_VERSION` in `src/app.js` e `CACHE` in `sw.js`, così i telefoni scaricano la versione nuova.
