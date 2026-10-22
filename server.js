
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const ITF_CALENDAR_URL = "https://www.itftennis.com/en/tournament-calendar/womens-world-tennis-tour-calendar/";

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
    id: item.id || (item.name + "|" + (item.date || "")),
    name: item.name || "Naam niet beschikbaar",
    date: item.date || null,
    tier: item.tier || "",
    category: item.tier || "",
    surface: item.surface || "",
    country: item.country || "",
    countryCode: item.countryCode || "",
    round: item.tier || "",
    link: item.link || ITF_CALENDAR_URL,
    source: "Officiële ITF-website"
  };
}

function toIsoDate(value, yearHint) {
  if (!value) return null;
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return direct.toISOString().slice(0, 10);
  }
  const m = String(value).match(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})?/);
  if (!m) return null;
  const months = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
  const month = months[m[2].slice(0,3).toLowerCase()];
  if (!month) return null;
  const year = Number(m[3] || yearHint || new Date().getFullYear());
  return year + "-" + String(month).padStart(2,"0") + "-" + String(Number(m[1])).padStart(2,"0");
}

function parseCalendarHtml(html, year) {
  const cheerio = require("cheerio");
  const $ = cheerio.load(html);
  const found = [];
  const seen = new Set();

  const add = raw => {
    if (!raw || typeof raw !== "object") return;
    const name = raw.name || raw.tournamentName || raw.title || raw.eventName;
    if (typeof name !== "string" || name.trim().length < 3) return;
    const combined = [name, raw.category, raw.grade, raw.tier, raw.surface, raw.court, raw.country, raw.location].join(" ");
    const tierMatch = combined.match(/\b(W(?:15|25|35|50|60|75|100)|WTA\s*(?:125|250|500|1000)|Grand Slam)\b/i);
    const dateRaw = raw.startDate || raw.start_date || raw.start || raw.date || raw.startDateTime || raw.fromDate;
    const date = toIsoDate(dateRaw, year);
    const linkRaw = raw.url || raw.link || raw.href || raw.tournamentUrl;
    const link = typeof linkRaw === "string" && linkRaw.startsWith("http")
      ? linkRaw
      : typeof linkRaw === "string" && linkRaw.startsWith("/")
        ? "https://www.itftennis.com" + linkRaw
        : ITF_CALENDAR_URL;
    const id = raw.id || raw.tournamentId || (name.trim() + "|" + (date || ""));
    const key = String(id).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(normalizeTournament({
      id,
      name: name.trim(),
      date,
      tier: tierMatch ? tierMatch[1].replace(/\s+/g, " ") : (raw.category || raw.grade || raw.tier || ""),
      surface: typeof raw.surface === "string" ? raw.surface : (raw.court?.name || raw.surfaceName || ""),
      country: typeof raw.country === "string" ? raw.country : (raw.country?.name || raw.hostNation || raw.countryName || ""),
      countryCode: raw.countryCode || raw.countryAcronym || "",
      link
    }));
  };

  function walk(value, depth = 0) {
    if (depth > 8 || value == null) return;
    if (Array.isArray(value)) { value.forEach(item => walk(item, depth + 1)); return; }
    if (typeof value !== "object") return;
    add(value);
    Object.values(value).forEach(item => {
      if (item && typeof item === "object") walk(item, depth + 1);
    });
  }

  $("script").each((_, el) => {
    const type = ($(el).attr("type") || "").toLowerCase();
    const id = ($(el).attr("id") || "").toLowerCase();
    const body = $(el).html() || "";
    if (type.includes("json") || id.includes("state") || id.includes("data")) {
      try { walk(JSON.parse(body)); } catch {}
    }
  });

  $('a[href*="/en/tournament/"]').each((_, el) => {
    const anchor = $(el);
    const href = anchor.attr("href") || "";
    const name = anchor.text().replace(/\s+/g, " ").trim();
    if (!name || /calendar|tournament information/i.test(name)) return;
    let card = anchor;
    for (let i = 0; i < 5; i++) {
      const parent = card.parent();
      if (!parent.length) break;
      const text = parent.text().replace(/\s+/g, " ").trim();
      if (text.length > name.length && text.length < 1200 && (/\bW(?:15|25|35|50|75|100)\b/i.test(text) || /\d{1,2}\s+[A-Za-z]{3,9}\s+to\s+\d{1,2}/i.test(text))) {
        card = parent;
        break;
      }
      card = parent;
    }
    const text = card.text().replace(/\s+/g, " ").trim();
    const tier = (text.match(/\bW(?:15|25|35|50|75|100)\b/i) || [])[0] || "";
    const dateMatch = text.match(/(\d{1,2}\s+[A-Za-z]{3,9}\s+(?:\d{4}\s+)?to\s+\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i);
    const date = dateMatch ? toIsoDate(dateMatch[1].split(/\s+to\s+/i)[0], year) : null;
    const key = (name + "|" + (date || "")).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(normalizeTournament({
      id: key, name, date, tier,
      surface: (text.match(/(?:Outdoor|Indoor)\s*-\s*(?:Hard|Clay|Grass|Carpet)/i) || [])[0] || "",
      country: "",
      link: href.startsWith("http") ? href : "https://www.itftennis.com" + href
    }));
  });

  return found.filter(item => item.tier && item.date);
}

async function fetchCalendar(year) {
  const startDate = year + "-01-01";
  const endDate = year + "-12-31";
  const url = ITF_CALENDAR_URL + "?startdate=" + startDate + "&enddate=" + endDate;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; COURT-IQ/1.0; public-calendar-reader)",
      "Accept": "text/html,application/xhtml+xml"
    },
    signal: AbortSignal.timeout(25000)
  });
  if (!response.ok) {
    throw new Error("De openbare ITF-kalender gaf HTTP " + response.status + " terug voor " + year + ".");
  }
  const html = await response.text();
  const events = parseCalendarHtml(html, year);
  if (!events.length) {
    throw new Error("De openbare ITF-kalender voor " + year + " is bereikbaar, maar de toernooien konden niet automatisch uit de pagina worden gelezen. De bestaande gegevens blijven behouden.");
  }
  return events;
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
    lastError = "De openbare ITF-website gaf geen leesbare toernooien terug. Bestaande gegevens blijven behouden.";
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
    message: `${tournaments.length} toernooien uit de openbare ITF-kalender geladen voor ${successful.map(item => item.year).join(" en ")}.`
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
    source: "Officiële ITF-website",
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
