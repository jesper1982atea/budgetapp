# Budgetapp – Bolånekalkyl

En enkel fullstack-applikation byggd med Node.js och React för att räkna ut hur mycket du behöver lägga undan varje månad för bolånet och övriga hushållskostnader baserat på nettolön per månad, ränta och amorteringstid.

## Funktioner

- Kalkylerar månadsränta, amortering och total bolånekostnad med hjälp av ett Express-API.
- Stöd för flera inkomsttagare – lägg till en rad per person med eget skattetabellval och brutto-/brutolöneavdrag så summeras nettolönen automatiskt (inkl. skattejämkning från ränteavdrag om du aktiverar den).
- Lägg till egna kostnadsposter (t.ex. bredband, försäkring, termins/säsongsavgifter) per månad, kvartal, termin (6 mån) eller säsong (4 mån) — belopp omräknas automatiskt till månadsnivå. Delade kostnader (t.ex. barns fritidsaktiviteter) kan markeras för att endast räkna med din halva.
- Specifik sektion för elräkning: ange total årsförbrukning (kWh/år) och snittpris så räknas motsvarande månadsbelopp automatiskt in i budgeten.
- Visar hur stor andel av nettolönen som går åt, hur mycket som blir kvar och total summa att spara per månad, inklusive ett scenario för framtida amortering där nuvarande krav minskas med 1 %-enhet (automatiskt ned till minst 1 %, t.ex. 2% → 1% efter april 2026).
- Ange fastighetsvärde för att se belåningsgrad, vilket amorteringskrav som gäller (0/1/2 %) och hur kvoten minskar i prognosen.
- Tydlig kostnadstabell med export till Excel (CSV), delad kostnadsöversikt och PDF-export av hela rapporten (via webbläsarens utskriftsdialog).
- Tydlig kostnadstabell med export till Excel (CSV) samt en separat prognos/diagram-tab som visar hur lånet minskar över tid (1–40 år) baserat på vald amortering.
- Lånesektionen kan delas upp i flera delar med egna villkor; totalsumma, snittränta och månadsränta/amortering presenteras automatiskt.
- Spara dina uppgifter (inklusive kostnadsposter, fastighetsdata och inkomster) lokalt via `localStorage`.

## Komma igång

1. **Installera beroenden**
   ```bash
   cd server && npm install
   cd ../client && npm install
   ```
2. **Starta backend (Express)**
   ```bash
   cd server
   npm run start
   # servern körs på http://localhost:4000
   ```
3. **Starta frontend (Vite + React)**
   ```bash
   cd client
   cp .env.example .env # valfritt, ändra VITE_API_BASE_URL vid behov
   npm run dev
   # öppna sedan http://localhost:5173
   ```
4. **Kör den initiala serverkonfigurationen**  
   Första gången du öppnar appen visas ett kort där du sätter ett adminlösenord och anger din Google Maps Places API-nyckel. Dessa värden sparas krypterat i SQLite-databasen och behöver därför inte ligga i `.env` eller versionshanteringen.

> Obs! Backend tillåter CORS så att utvecklingsservern för React kan prata med API:t direkt.

> Tips: Dina uppgifter auto-sparas i webbläsarens `localStorage` (och kan även sparas manuellt via knappen **"Spara uppgifter"**). De fylls i automatiskt nästa gång du öppnar appen tills du väljer **"Rensa sparade"**.

## API

`POST /api/calculate`

```json
{
  "income": 35000,
  "loanAmount": 2500000,
  "annualInterestRate": 4.2,
  "amortizationPercent": 2
}
```

Svar:

```json
{
  "income": 35000,
  "loanAmount": 2500000,
  "annualInterestRate": 4.2,
  "amortizationPercent": 2,
  "monthlyInterest": 8750,
  "monthlyAmortization": 4166.666666666667,
  "totalMonthlyCost": 12916.666666666666,
  "incomeShare": 0.3690476190476191
}
```

`income` är nettolön per månad i kronor. `incomeShare` visar hur stor del av denna lön som går till bolånet. Amorteringen anges i procent av total lånesumma per år och fördelas lika över årets månader.

> Övriga kostnadsposter hanteras i frontend, där du kan lägga till månads-, kvartals- eller årsavgifter samt elförbrukning (kWh per år + snittpris) som automatiskt räknas om till vad du behöver lägga undan varje månad.

### Serverinställningar

- `GET /api/settings/status` – används av klienten för att avgöra om adminlösenord och Google Maps-nyckel redan är satta (`{ adminConfigured: boolean, googleKeyConfigured: boolean }`).
- `POST /api/settings/initialize` – sätt/uppdatera adminlösenord och Google Maps Places-nyckel.  
  Body:
  ```json
  {
    "adminPassword": "nytt-lösen",
    "googleMapsKey": "AIza..."
  }
  ```
  * Vid första konfigurationen måste båda fälten anges.
  * Vid uppdatering anger du det gamla adminlösenordet i headern `X-Admin-Key` och kan därefter byta lösenord och/eller API-nyckel.

## Teknisk översikt

- **Server**: Express med JSON-API (`server/index.js`).
- **Klient**: React + Vite (`client/src`) med ett formulär som skickar data till API:t och presenterar resultatet.
- **Miljövariabler**: `VITE_API_BASE_URL` (frontend) för att peka på rätt backend-URL. Adminlösenordet och Google Places-nyckeln sätts i stället via `/api/settings/initialize` och sparas i SQLite.

## Docker

Det finns en färdig `Dockerfile` och `docker-compose.yml` som bygger klienten och servern i en och samma container (Express serverar den bundlade klienten).

```bash
# Bygg och starta (förutsätter Docker/Docker Compose v2)
docker compose up --build

# Applikationen exponeras på http://localhost:4000
```

Vill du bara bygga själva bilden:

```bash
docker build -t budgetapp .
docker run -p 4000:4000 budgetapp
```

## Publicera på GitHub

1. Initiera ett Git-repo i projektroten (om du inte redan har ett):
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   ```
2. Skapa ett tomt repo på GitHub och kopiera dess URL, t.ex. `https://github.com/<user>/budgetapp.git`.
3. Lägg till GitHub som remote och pusha:
   ```bash
   git remote add origin https://github.com/<user>/budgetapp.git
   git branch -M main
   git push -u origin main
   ```

Nu är projektet redo att delas och köras via GitHub, Docker eller klassisk Node-miljö. Glöm inte att sätta `NODE_ENV=production` i Docker/hosting-läge så att Express serverar den bundlade klienten.
