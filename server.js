const express = require("express");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

const ITF_URL =
  "https://www.itftennis.com/en/tournament-calendar/womens-world-tennis-tour-calendar/";

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

let lastRefresh = null;
let tournaments = [];

function clean(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

async function fetchITFCalendar() {
  const response = await fetch(ITF_URL, {
    headers: {
      "User-Agent": "COURT-IQ/1.0 (tournament calendar reader)",
      "Accept": "text/html"
    },
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error(`ITF returned HTTP ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const found = [];

  $("table tr").each((_, row) => {
    const cells = $(row)
      .find("th, td")
      .map((_, cell) => clean($(cell).text()))
      .get();

    if (cells.length < 6) return;

    const combined = cells.join(" ");
    const categoryMatch = combined.match(/\b(W15|W35|W50|W75|W100)\b/);

    if (!categoryMatch) return;

    const surface = cells.find(text =>
      /outdoor|indoor|clay|hard|grass/i.test(text)
    ) || "";

    const prize = cells.find(text =>
      /\$[\d,]+/.test(text)
    ) || "";

    const date = cells.find(text =>
      /\d{1,2}\s+[A-Za-z]{3}/.test(text) &&
      /\d{4}/.test(text)
    ) || cells.find(text =>
      /\d{1,2}\s+[A-Za-z]{3}/.test(text)
    ) || "";

    const name = cells.find(text =>
      /\b(W15|W35|W50|W75|W100)\b/.test(text)
    ) || "";

    if (!name || !date) return;

    found.push({
      name,
      category: categoryMatch[1],
      date,
      country: "",
      city: "",
      surface,
      prize,
      source: ITF_URL
    });
  });

  const unique = [
    ...new Map(found.map(item => [
      [item.name, item.date, item.surface].join("|"),
      item
    ])).values()
  ];

  if (unique.length === 0) {
    throw new Error(
      "Could not reliably read tournament rows from the ITF page. No data was replaced."
    );
  }

  tournaments = unique;
  lastRefresh = new Date().toISOString();

  return unique;
}

app.get("/api/debug-itf", async (req, res) => {
  try {
    const response = await fetch(ITF_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; COURT-IQ/1.0)",
        "Accept": "text/html,application/xhtml+xml"
      },
      signal: AbortSignal.timeout(20000)
    });

    const html = await response.text();
    const $ = cheerio.load(html);

    res.json({
      httpStatus: response.status,
      contentType: response.headers.get("content-type"),
      htmlLength: html.length,
      title: clean($("title").first().text()),
      tableCount: $("table").length,
      rowCount: $("tr").length,
      scriptSources: $("script[src]")
        .map((_, el) => $(el).attr("src"))
        .get()
        .slice(0, 30),
      bodyPreview: clean($("body").text()).slice(0, 1500)
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error.message
    });
  }
});


app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "COURT IQ" });
});

app.get("/api/status", (req, res) => {
  res.json({
    source: ITF_URL,
    lastRefresh,
    tournamentCount: tournaments.length,
    liveDataLoaded: tournaments.length > 0
  });
});

app.get("/api/tournaments", (req, res) => {
  res.json({
    source: ITF_URL,
    lastRefresh,
    count: tournaments.length,
    tournaments
  });
});

app.get("/api/refresh", async (req, res) => {
  try {
    const data = await fetchITFCalendar();
    res.json({
      ok: true,
      message: `Loaded ${data.length} tournaments from the ITF calendar.`,
      count: data.length,
      lastRefresh
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      message: "ITF calendar could not be read. No new data was loaded.",
      error: error.message
    });
  }
});

app.post("/api/refresh", async (req, res) => {
  try {
    const data = await fetchITFCalendar();
    res.json({
      ok: true,
      message: `Loaded ${data.length} tournaments from the ITF calendar.`,
      count: data.length,
      lastRefresh
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      message: "ITF calendar could not be read. No new data was loaded.",
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`COURT IQ backend running on port ${PORT}`);
});