
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
    throw new Error(`Kalender ${year}: SportsAPI365 gaf HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  let result;
  try {
    result = JSON.parse(body);
  } catch {
    throw new Error(`Kalender ${year}: SportsAPI365 stuurde geen geldige JSON terug.`);
  }

  if (!Array.isArray(result.data)) {
    throw new Error(`Kalender ${year}: de API-respons bevat geen herkenbare toernooilijst.`);
  }

  return result.data.map(normalizeTournament);
}

function deduplicateTournaments(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.id != null
      ? `id:${item.id}`
      : `name-date:${String(item.name || "").trim().toLowerCase()}|${String(item.date || "").slice(0, 10)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function refreshCalendar(req, res) {
  const currentYear = new Date().getFullYear();
  const requestedYear = Number(req.query.year || currentYear);

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

  // Always request two consecutive years so the calendar's "next 12 months"
  // and "all dates" views can include tournaments announced for next year.
  const years = [requestedYear, requestedYear + 1];
  const results = await Promise.allSettled(years.map(year => fetchCalendar(year)));
  const successful = [];
  const errors = [];

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      successful.push({ year: years[index], data: result.value });
    } else {
      errors.push(result.reason?.message || `Kalender ${years[index]} ophalen mislukt.`);
    }
  });

  if (!successful.length) {
    lastError = errors.join(" ");
    return res.status(502).json({
      ok: false,
      error: lastError,
      existingCount: tournaments.length,
      lastRefresh
    });
  }

  const combined = deduplicateTournaments(successful.flatMap(item => item.data));
  if (!combined.length) {
    lastError = "De API gaf geen toernooien terug. Bestaande gegevens blijven behouden.";
    return res.status(502).json({
      ok: false,
      error: lastError,
      existingCount: tournaments.length,
      lastRefresh
    });
  }

  tournaments = combined;
  lastRefresh = new Date().toISOString();
  lastError = errors.length ? errors.join(" ") : null;

  res.json({
    ok: true,
    years: successful.map(item => item.year),
    count: tournaments.length,
    lastRefresh,
    warning: errors.length ? errors.join(" ") : null,
    message: `${tournaments.length} unieke toernooien geladen voor ${successful.map(item => item.year).join(" en ")} via SportsAPI365.`
  });
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

  const apiKey = process.env.SPORTSAPI365_KEY;
  if (!apiKey) {
    return res.status(503).json({ ok: false, error: "De spelerszoekfunctie is niet geconfigureerd." });
  }

  const headers = {
    "X-Gravitee-Api-Key": apiKey,
    "Accept": "application/json"
  };
  const normalize = value => String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  try {
    // Use the documented SportsAPI365 search endpoint, rather than relying
    // on the public WTA ranking endpoint's undocumented response structure.
    const searchUrl = `${API_BASE}/search?search=${encodeURIComponent(name)}`;
    const searchResponse = await fetch(searchUrl, {
      headers,
      signal: AbortSignal.timeout(15000)
    });
    const searchBody = await searchResponse.text();

    if (!searchResponse.ok) {
      throw new Error(`SportsAPI365 zoekopdracht mislukt (HTTP ${searchResponse.status}).`);
    }

    let searchData;
    try {
      searchData = JSON.parse(searchBody);
    } catch {
      throw new Error("De spelerszoekfunctie gaf geen geldige JSON terug.");
    }

    const buckets = Array.isArray(searchData.data) ? searchData.data : [];
    const playerBucket = buckets.find(bucket => bucket.category === "player_wta");
    const rawPlayers = playerBucket && Array.isArray(playerBucket.result) ? playerBucket.result : [];
    const query = normalize(name);
    const candidates = rawPlayers
      .map(player => typeof player === "string" ? { name: player } : player)
      .filter(player => player.name && (
        normalize(player.name) === query ||
        normalize(player.name).includes(query)
      ))
      .slice(0, 8);

    const matches = await Promise.all(candidates.map(async player => {
      let ranking = Number(player.currentRank || player.ranking || player.rank || 0) || null;
      let country = player.countryAcr || player.countryCode || player.country || "";
      let rankingDate = player.rankingDate || player.rankDate || player.lastUpdated || null;

      // The search response is name-oriented. Ask the documented profile
      // endpoint for ranking details when available.
      try {
        const profileUrl = `${API_BASE}/profile/${encodeURIComponent(player.name)}?type=wta`;
        const profileResponse = await fetch(profileUrl, {
          headers,
          signal: AbortSignal.timeout(10000)
        });
        if (profileResponse.ok) {
          const profile = await profileResponse.json();
          const profileData = profile.data && !Array.isArray(profile.data) ? profile.data : profile;
          ranking = Number(
            profileData.currentRank ||
            profileData.currentRanking ||
            profileData.ranking ||
            profileData.rank ||
            profileData.curRank?.rank ||
            profileData.curRank?.position ||
            ranking ||
            0
          ) || null;
          country = profileData.countryAcr || profileData.countryCode || profileData.country?.name || profileData.country?.acronym || country;
          rankingDate = profileData.rankingDate || profileData.rankDate || profileData.rankingUpdated || profileData.lastUpdated || profileData.curRank?.date || rankingDate;
        }
      } catch {
        // Keep the name match even if ranking details are temporarily unavailable.
      }

      return { name: player.name, ranking, country, rankingDate };
    }));

    res.setHeader("Cache-Control", "public, max-age=1800");
    res.json({
      ok: true,
      matches,
      source: "SportsAPI365",
      message: matches.length ? "" : "Geen speelster gevonden. Controleer de spelling of probeer alleen de achternaam."
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error.message || "Spelersranking ophalen is mislukt."
    });
  }
});

app.get("/api/refresh", refreshCalendar);
app.post("/api/refresh", refreshCalendar);

app.listen(PORT, () => {
  console.log(`COURT IQ backend draait op poort ${PORT}`);
});
