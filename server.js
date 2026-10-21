
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const API_BASE = "https://api.sportsapi365.com/v1/tennis";

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

let tournaments = [];
let lastRefresh = null;
let lastError = null;

function normalizeTournament(item) {
  return {
    id: item.id,
    name: item.name || "Naam niet beschikbaar",
    date: item.date || null,
    tier: item.tier || "",
    category: item.tier || item.round?.name || "",
    surface: item.court?.name || "",
    country: item.country?.name || "",
    countryCode: item.country?.acronym || "",
    round: item.round?.name || "",
    link: item.link || "",
    source: "SportsAPI365"
  };
}

async function fetchCalendar(year) {
  const apiKey = process.env.SPORTSAPI365_KEY;

  if (!apiKey) {
    throw new Error("SPORTSAPI365_KEY ontbreekt in de Render-omgevingsvariabelen.");
  }

  const response = await fetch(
    `${API_BASE}/wta/tournament/calendar/${year}`,
    {
      headers: {
        "X-Gravitee-Api-Key": apiKey,
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(20000)
    }
  );

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`SportsAPI365 gaf HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  let result;

  try {
    result = JSON.parse(body);
  } catch {
    throw new Error("SportsAPI365 stuurde geen geldige JSON terug.");
  }

  if (!Array.isArray(result.data)) {
    throw new Error("De API-respons bevat geen herkenbare toernooilijst.");
  }

  const normalized = result.data.map(normalizeTournament);

  if (normalized.length === 0) {
    throw new Error("De API gaf geen toernooien terug. Bestaande gegevens blijven behouden.");
  }

  tournaments = normalized;
  lastRefresh = new Date().toISOString();
  lastError = null;

  return tournaments;
}

async function refreshCalendar(req, res) {
  const requestedYear = Number(req.query.year || new Date().getFullYear());

  if (
    !Number.isInteger(requestedYear) ||
    requestedYear < 2020 ||
    requestedYear > 2100
  ) {
    return res.status(400).json({
      ok: false,
      error: "Ongeldig jaartal."
    });
  }

  try {
    const data = await fetchCalendar(requestedYear);

    res.json({
      ok: true,
      year: requestedYear,
      count: data.length,
      lastRefresh,
      message: `${data.length} echte toernooien geladen via SportsAPI365.`
    });
  } catch (error) {
    lastError = error.message;

    res.status(502).json({
      ok: false,
      error: error.message,
      existingCount: tournaments.length,
      lastRefresh
    });
  }
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "COURT IQ"
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    source: "SportsAPI365",
    lastRefresh,
    tournamentCount: tournaments.length,
    liveDataLoaded: tournaments.length > 0,
    lastError
  });
});

app.get("/api/tournaments", (req, res) => {
  res.json({
    source: "SportsAPI365",
    lastRefresh,
    count: tournaments.length,
    tournaments
  });
});


app.get("/api/player-ranking", async (req, res) => {
  const name = String(req.query.name || "").trim();
  if (name.length < 2) {
    return res.status(400).json({ ok: false, error: "Vul minstens 2 letters van de speelsternaam in." });
  }

  try {
    const url = "https://api.wtatennis.com/tennis/players/ranked?type=rankSingles&metric=singles&page=0&pageSize=1000";
    const response = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw new Error("De WTA-ranking is tijdelijk niet beschikbaar (HTTP " + response.status + ").");
    }

    const rows = await response.json();
    if (!Array.isArray(rows)) {
      throw new Error("De WTA-ranking gaf een onverwacht antwoord terug.");
    }

    const normalize = value => String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const query = normalize(name);
    const matches = rows.filter(row => {
      const fullName = normalize(row.player?.fullName || row.fullName || row.name);
      return fullName === query || fullName.includes(query);
    }).slice(0, 8).map(row => ({
      name: row.player?.fullName || row.fullName || row.name,
      ranking: Number(row.ranking || row.rank || 0) || null,
      country: row.player?.countryCode || row.player?.country || row.countryCode || ""
    }));

    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json({ ok: true, matches, source: "WTA", message: matches.length ? "" : "Geen overeenkomst gevonden in de gepubliceerde WTA-singlesranking. Controleer de spelling of probeer de volledige naam." });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message || "Spelersranking ophalen is mislukt." });
  }
});

app.get("/api/refresh", refreshCalendar);
app.post("/api/refresh", refreshCalendar);

app.listen(PORT, () => {
  console.log(`COURT IQ backend draait op poort ${PORT}`);
});
