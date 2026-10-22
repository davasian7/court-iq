
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const ITF_CALENDAR_URL = "https://www.itftennis.com/en/tournament-calendar/womens-world-tennis-tour-calendar/";
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
let calendarDiagnostics = { checkedAt: null, httpStatus: null, contentType: null, htmlLength: null, title: null, scriptCount: null, tableRowCount: null, hasNextData: null, hasTournamentText: null };

function normalizeTournament(item) {
  const country = typeof item.country === "string" ? item.country : (item.country?.name || item.hostNation || item.countryName || "");
  const countryCode = item.countryCode || item.country?.acronym || item.countryAcronym || "";
  const surface = typeof item.surface === "string" ? item.surface : (item.court?.name || item.surfaceName || "");
  const tier = item.tier || item.category || item.round?.name || "";
  return {
    id: item.id || item.tournamentId || (item.name + "|" + (item.date || "")),
    name: item.name || item.tournamentName || "Naam niet beschikbaar",
    date: item.date || item.startDate || null,
    tier,
    category: tier,
    surface,
    country,
    countryCode,
    round: item.round?.name || tier,
    link: item.link || item.url || ITF_CALENDAR_URL,
    source: item.source || "SportsAPI365"
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

  // Current ITF calendar renders its records in a table. Parse table rows
  // directly as a fallback because the page's embedded JSON structure changes.
  $("tr").each((_, row) => {
    const cells = $(row).find("th, td").map((__, cell) =>
      $(cell).text().replace(/\s+/g, " ").trim()
    ).get();
    if (cells.length < 5) return;
    const joined = cells.join(" | ");
    if (/^name\s*\|/i.test(joined) || /tournament name/i.test(cells[0])) return;

    const name = (cells[0] || "").replace(/\s+/g, " ").trim();
    const dateCell = cells.find(cell => /\d{1,2}\s+[A-Za-z]{3,9}\s+to\s+\d{1,2}\s+[A-Za-z]{3,9}/i.test(cell));
    const tierCell = cells.find(cell => /\bW(?:15|25|35|50|60|75|100)\b/i.test(cell));
    const surfaceCell = cells.find(cell => /(?:Outdoor|Indoor)\s*-\s*(?:Hard|Clay|Grass|Carpet)/i.test(cell)) || "";
    const countryCell = cells.find(cell => /^(?:USA|Portugal|France|Italy|Spain|Germany|Great Britain|Australia|Canada|China|Japan|Belgium|Netherlands|Tunisia|Turkey|Egypt|Brazil|India|Mexico|Poland|Czechia|Croatia|Greece|Sweden|Norway|Denmark|Austria|Switzerland|Romania|Bulgaria|Finland|Ireland|Israel|Thailand|Vietnam|Korea|South Korea|New Zealand|Argentina|Chile|Colombia|South Africa|Morocco|Portugal|United States|United Kingdom)(?:\s|$)/i.test(cell)) || "";
    if (!name || !dateCell || !tierCell) return;
    const dateMatch = dateCell.match(/(\d{1,2}\s+[A-Za-z]{3,9}\s+to\s+\d{1,2}\s+[A-Za-z]{3,9}(?:\s+\d{4})?)/i);
    const date = dateMatch ? toIsoDate(dateMatch[1].split(/\s+to\s+/i)[0], year) : null;
    if (!date) return;
    const link = $(row).find('a[href*="/en/tournament/"]').first().attr("href")
      || $(row).find("a[href]").first().attr("href") || "";
    const id = (name + "|" + date).toLowerCase();
    if (seen.has(id)) return;
    seen.add(id);
    found.push(normalizeTournament({
      id, name, date,
      tier: (tierCell.match(/\bW(?:15|25|35|50|60|75|100)\b/i) || [])[0] || tierCell,
      surface: surfaceCell,
      country: countryCell,
      link: link.startsWith("http") ? link : link.startsWith("/") ? "https://www.itftennis.com" + link : ITF_CALENDAR_URL
    }));
  });

  return found.filter(item => item.tier && item.date);
}

async function fetchCalendar(year) {
  const apiKey = process.env.SPORTSAPI365_KEY;
  if (!apiKey) {
    throw new Error("SPORTSAPI365_KEY ontbreekt in de Render-omgevingsvariabelen.");
  }
  const response = await fetch(`${API_BASE}/wta/tournament/calendar/${year}`, {
    headers: {
      "X-Gravitee-Api-Key": apiKey,
      "Accept": "application/json"
    },
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`SportsAPI365 kalender ${year}: HTTP ${response.status}: ${body.slice(0, 180)}`);
  }
  let result;
  try { result = JSON.parse(body); }
  catch { throw new Error(`SportsAPI365 kalender ${year}: ongeldige JSON-respons.`); }
  if (!Array.isArray(result.data)) {
    throw new Error(`SportsAPI365 kalender ${year}: geen toernooilijst in de respons.`);
  }
  const events = result.data.map(item => normalizeTournament({ ...item, source: "SportsAPI365" }));
  if (!events.length) throw new Error(`SportsAPI365 kalender ${year}: geen toernooien teruggekregen.`);
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

app.get("/api/itf-browser-test", async (req, res) => {
  const year = Number(req.query.year || new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    return res.status(400).json({ ok: false, error: "Ongeldig jaartal." });
  }
  let browser;
  try {
    const chromium = require("@sparticuz/chromium");
    const puppeteer = require("puppeteer-core");
    const browserUrl = ITF_CALENDAR_URL + "?categories=All&startdate=" + year;
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1365, height: 900 },
      executablePath: await chromium.executablePath(),
      headless: true
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
    await page.goto(browserUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    try { await page.waitForSelector("table tr, [role='row']", { timeout: 20000 }); } catch {}
    await new Promise(resolve => setTimeout(resolve, 2500));
    const diagnostics = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tr, [role='row']"))
        .map(row => (row.innerText || row.textContent || "").replace(/\\s+/g, " ").trim())
        .filter(Boolean);
      return {
        title: document.title,
        url: location.href,
        pageTextLength: (document.body?.innerText || "").length,
        bodyPreview: (document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 700),
        rowCount: rows.length,
        sampleRows: rows.slice(0, 8),
        hasIncapsula: document.documentElement.outerHTML.includes("_Incapsula_Resource")
      };
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: diagnostics.rowCount > 1 && !diagnostics.hasIncapsula, source: "Officiële ITF-website via headless browser", year, diagnostics });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message || "Browserproef mislukt." });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

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
    lastError,
    calendarDiagnostics
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




const WTA_RANKINGS_URL = "https://api.wtatennis.com/tennis/players/ranked";
let wtaRankingCache = { players: [], fetchedAt: null };
const WTA_RANKING_CACHE_MS = 6 * 60 * 60 * 1000;

function normalizePlayerName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractWtaRows(payload) {
  const found = [];
  const seen = new Set();
  function walk(value, depth = 0) {
    if (!value || depth > 7) return;
    if (Array.isArray(value)) { value.forEach(item => walk(item, depth + 1)); return; }
    if (typeof value !== "object") return;
    const player = value.player && typeof value.player === "object" ? value.player : value;
    const name = player.fullName || player.name || player.playerName || value.playerName || value.full_name || "";
    const rankValue = value.ranking ?? value.rank ?? value.position ?? value.currentRank ?? value.currentRanking ?? value.curRank?.rank ?? value.curRank?.position;
    const ranking = Number(rankValue || 0);
    if (name && Number.isFinite(ranking) && ranking > 0) {
      const key = normalizePlayerName(name);
      if (key && !seen.has(key)) {
        seen.add(key);
        found.push({
          name: String(name).trim(), normalizedName: key, ranking,
          points: Number(value.points ?? value.rankingPoints ?? value.ranking_points ?? 0) || null,
          country: player.countryCode || player.countryAcr || player.country?.acronym || "",
          rankingDate: value.rankedAt || value.rankingDate || value.ranking_date || value.date || null,
          profileUrl: player.id ? "https://www.wtatennis.com/players/" + player.id : null
        });
      }
    }
    Object.values(value).forEach(child => { if (child && typeof child === "object") walk(child, depth + 1); });
  }
  walk(payload);
  return found;
}

async function fetchWtaRankings() {
  if (wtaRankingCache.players.length && wtaRankingCache.fetchedAt &&
      Date.now() - wtaRankingCache.fetchedAt < WTA_RANKING_CACHE_MS) return wtaRankingCache.players;

  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; COURT-IQ/1.0; public-ranking-reader)",
    "Accept": "application/json, text/html, */*",
    "Referer": "https://www.wtatennis.com/rankings/singles"
  };
  const playersByName = new Map();
  let lastError = "Geen bruikbare WTA-rankinggegevens gevonden.";

  // The WTA endpoint is paginated. Request pages of 100 until it returns
  // fewer than 100 players, so players ranked beyond 100 are included too.
  try {
    for (let page = 0; page < 20; page++) {
      const sourceUrl = "https://api.wtatennis.com/tennis/players/ranked?type=rankSingles&metric=singles&page=" + page + "&pageSize=100";
      const response = await fetch(sourceUrl, {
        headers,
        signal: AbortSignal.timeout(20000)
      });
      if (!response.ok) {
        lastError = "De officiële WTA-bron gaf HTTP " + response.status + " terug.";
        break;
      }
      const payload = await response.json();
      const rows = extractWtaRows(payload);
      for (const player of rows) playersByName.set(player.normalizedName, player);

      // Ranking endpoint returns a list; a short/empty page means the end.
      const rawCount = Array.isArray(payload) ? payload.length :
        (Array.isArray(payload?.content) ? payload.content.length : rows.length);
      if (rawCount < 100) break;
    }
    if (playersByName.size) {
      const players = [...playersByName.values()].sort((a, b) => a.ranking - b.ranking);
      wtaRankingCache = { players, fetchedAt: Date.now() };
      return players;
    }
  } catch (error) {
    lastError = error.message || lastError;
  }

  // Fallback to the public WTA ranking page if the JSON endpoint is unavailable.
  try {
    const response = await fetch("https://www.wtatennis.com/rankings/singles", {
      headers,
      signal: AbortSignal.timeout(20000)
    });
    if (response.ok) {
      const body = await response.text();
      const cheerio = require("cheerio");
      const $ = cheerio.load(body);
      const extracted = [];
      $("script").each((_, element) => {
        const script = $(element).html() || "";
        try { extracted.push(...extractWtaRows(JSON.parse(script))); } catch {}
      });
      if (extracted.length) {
        const unique = [...new Map(extracted.map(player => [player.normalizedName, player])).values()];
        wtaRankingCache = { players: unique, fetchedAt: Date.now() };
        return unique;
      }
      lastError = "De WTA-pagina is bereikbaar, maar de rankinggegevens zijn niet herkenbaar in de HTML.";
    } else {
      lastError = "De officiële WTA-pagina gaf HTTP " + response.status + " terug.";
    }
  } catch (error) {
    lastError = error.message || lastError;
  }
  throw new Error(lastError);
}

app.get("/api/wta-player-search", async (req, res) => {
  const query = String(req.query?.q || "").trim();
  if (query.length < 2 && !/^\d+$/.test(query)) return res.json({ ok: true, players: [] });
  try {
    const players = await fetchWtaRankings();
    const requestedRank = /^\d+$/.test(query) ? Number(query) : null;
    if (requestedRank !== null) {
      const exact = players.find(player => player.ranking === requestedRank);
      res.setHeader("Cache-Control", "no-store");
      return res.json({
        ok: true,
        source: "Officiële WTA-ranking",
        count: exact ? 1 : 0,
        players: exact ? [{
          name: exact.name, ranking: exact.ranking, country: exact.country,
          points: exact.points, profileUrl: exact.profileUrl
        }] : []
      });
    }

    const normalizedQuery = normalizePlayerName(query);
    const queryTokens = normalizedQuery.split(" ").filter(Boolean);
    const starts = [], tokenMatches = [], contains = [];
    for (const player of players) {
      const normalizedName = player.normalizedName;
      const nameTokens = normalizedName.split(" ");
      if (normalizedName.startsWith(normalizedQuery)) {
        starts.push(player);
      } else if (queryTokens.every(qToken => nameTokens.some(nameToken => nameToken.startsWith(qToken)))) {
        tokenMatches.push(player);
      } else if (normalizedName.includes(normalizedQuery)) {
        contains.push(player);
      }
    }
    // Keep the best-ranked players first within each match group, but allow
    // searching a partial first name, surname, or multiple partial name parts.
    const results = [...starts, ...tokenMatches, ...contains]
      .slice(0, 20)
      .map(player => ({
        name: player.name, ranking: player.ranking, country: player.country,
        points: player.points, profileUrl: player.profileUrl
      }));
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, source: "Officiële WTA-ranking", count: results.length, players: results });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message || "WTA-ranking ophalen mislukt." });
  }
});

app.post("/api/wta-entry-rankings", async (req, res) => {
  const names = Array.isArray(req.body?.names) ? req.body.names : [];
  const cleanNames = [...new Set(names.map(name => String(name || "").trim()).filter(name => name.length >= 2))];
  if (!cleanNames.length) {
    return res.status(400).json({ ok: false, error: "Geen geldige speelsternamen ontvangen." });
  }
  if (cleanNames.length > 500) {
    return res.status(400).json({ ok: false, error: "Maximaal 500 speelsters per aanvraag." });
  }

  try {
    const players = await fetchWtaRankings();
    const byName = new Map(players.map(player => [player.normalizedName, player]));
    const matches = cleanNames.map(name => {
      const found = byName.get(normalizePlayerName(name));
      return {
        requestedName: name,
        found: Boolean(found),
        player: found ? {
          name: found.name,
          ranking: found.ranking,
          points: found.points,
          country: found.country,
          rankingDate: found.rankingDate,
          profileUrl: found.profileUrl
        } : null
      };
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      source: "Officiële WTA-ranking",
      sourceUrl: "https://www.wtatennis.com/rankings/singles",
      fetchedAt: new Date(wtaRankingCache.fetchedAt).toISOString(),
      rankingPlayersLoaded: players.length,
      matches
    });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message || "WTA-ranking ophalen mislukt." });
  }
});

app.get("/api/refresh", refreshCalendar);
app.post("/api/refresh", refreshCalendar);

app.listen(PORT, () => {
  console.log(`COURT IQ backend draait op poort ${PORT}`);
});
