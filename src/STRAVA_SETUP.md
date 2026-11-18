# Invio automatico a CoachPeaking (via Strava)

Come funziona: quando lei salva un allenamento nell'app, l'app lo manda a Strava, e Strava lo gira a CoachPeaking. Lei non deve fare niente.

Serve una configurazione una tantum, in tre parti. Strava dà a ogni nuova app un solo utente (chi l'ha creata), quindi **l'app Strava va creata con l'account di lei, non con il tuo**.

## 1. Lei crea l'app su Strava (5 minuti, dal computer)

1. Accede a strava.com, poi apre https://www.strava.com/settings/api
2. Crea l'app con questi dati:
   - Nome: Rullo
   - Categoria: Training
   - Sito web: https://pier-car.github.io/rullo/
   - Descrizione: qualsiasi, ad es. "I miei allenamenti sul rullo"
   - Dominio di callback (Authorization Callback Domain): `pier-car.github.io` (solo il dominio, senza https://)
   - Icona: va bene `icon-512.png` della cartella dell'app
3. Nella pagina dell'app compaiono **ID cliente** e **Segreto cliente**. Te li manda in privato.

## 2. Tu crei il servizio su Cloudflare (gratis, 10 minuti)

1. Crea un account su cloudflare.com (gratuito).
2. Workers & Pages → Create → Create Worker. Nome: `rullo-strava`. Deploy.
3. Edit code: cancella tutto e incolla il contenuto di `strava-worker.js`. Deploy.
4. Settings → Variables and Secrets → aggiungi:
   - `STRAVA_CLIENT_ID` (tipo Text): l'ID cliente di lei
   - `STRAVA_CLIENT_SECRET` (tipo Secret): il segreto di lei
   - `ALLOWED_ORIGIN` (tipo Text): `https://pier-car.github.io`
5. Deploy di nuovo. In alto trovi l'indirizzo del servizio, tipo `https://rullo-strava.tuonome.workers.dev`.

## 3. Colleghi l'app al servizio

Su GitHub, nel file `index.html` cerca questa riga (è vicino all'inizio dello script dell'app):

```
const STRAVA = { workerUrl: '', clientId: '' };
```

e riempila:

```
const STRAVA = { workerUrl: 'https://rullo-strava.tuonome.workers.dev', clientId: '123456' };
```

Salva (commit). Dopo un minuto il sito si aggiorna.

## 4. Lei collega gli account

1. Nell'app: Profilo → "Collega Strava" → conferma. Lascia spuntata la scrittura delle attività.
2. Su CoachPeaking: Calendario → menu in alto a destra → Account → Connessioni → collega Strava.
3. Fatto: l'allenamento di oggi parte da solo, e da lì ogni allenamento salvato.

## Cose da sapere

- Non attivare nell'app COROS l'invio a Strava, altrimenti le corse dell'orologio arrivano due volte a CoachPeaking.
- Gli allenamenti compaiono sul profilo Strava di lei con la visibilità che ha già impostato in Strava.
- Se non c'è rete al momento del salvataggio, l'allenamento resta in coda e parte da solo appena torna la connessione. In Profilo vede cosa è in coda.
- Il servizio su Cloudflare non salva nulla: serve solo a tenere nascosto il segreto dell'app Strava.
- Per scollegare: Profilo → Scollega. Per revocare anche su Strava: Impostazioni → Le mie app.
