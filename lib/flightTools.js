const fs = require("fs/promises");
const path = require("path");

const CITY_TO_AIRPORTS = {
  milan: ["MXP", "LIN", "BGY"],
  brussels: ["BRU", "CRL"],
  rome: ["FCO", "CIA"],
  paris: ["CDG", "ORY"],
  london: ["LHR", "LGW", "STN"],
};

const MOCK_FLIGHTS = [
  { flight_number: "AZ2041", airline: "ITA Airways", origin: "LIN", destination: "BRU", date: "2026-05-15", departure_time: "07:20", arrival_time: "09:00", price: 79, currency: "EUR" },
  { flight_number: "FR3650", airline: "Ryanair", origin: "BGY", destination: "CRL", date: "2026-05-15", departure_time: "06:45", arrival_time: "08:25", price: 49, currency: "EUR" },
  { flight_number: "SN3148", airline: "Brussels Airlines", origin: "MXP", destination: "BRU", date: "2026-05-15", departure_time: "10:55", arrival_time: "12:30", price: 122, currency: "EUR" },
  { flight_number: "U23971", airline: "easyJet", origin: "MXP", destination: "BRU", date: "2026-05-15", departure_time: "13:40", arrival_time: "15:15", price: 95, currency: "EUR" },
  { flight_number: "FR3652", airline: "Ryanair", origin: "BGY", destination: "CRL", date: "2026-05-16", departure_time: "09:10", arrival_time: "10:50", price: 55, currency: "EUR" },
  { flight_number: "AZ2043", airline: "ITA Airways", origin: "LIN", destination: "BRU", date: "2026-05-16", departure_time: "17:30", arrival_time: "19:10", price: 88, currency: "EUR" },
];

function normalizeLocation(value) {
  if (!value) return [];
  const raw = String(value).trim().toLowerCase();
  const code = raw.toUpperCase();
  if (code.length === 3) return [code];
  return CITY_TO_AIRPORTS[raw] || [];
}

function formatFlightLine(f, idx) {
  return `${idx + 1}. ${f.airline} ${f.flight_number} | ${f.origin} -> ${f.destination} | ${f.date} ${f.departure_time}-${f.arrival_time} | ${f.price} ${f.currency}`;
}

function searchFlights(args = {}) {
  const origin = args.origin || args.from;
  const destination = args.destination || args.to;
  const date = args.date;
  const maxResults = Math.max(1, Math.min(Number(args.max_results || 5), 20));

  const origins = normalizeLocation(origin);
  const destinations = normalizeLocation(destination);

  if (!origins.length || !destinations.length || !date) {
    return {
      ok: false,
      error: "Missing or invalid parameters. Required: origin, destination, date (YYYY-MM-DD).",
    };
  }

  const results = MOCK_FLIGHTS
    .filter((f) => f.date === date && origins.includes(f.origin) && destinations.includes(f.destination))
    .sort((a, b) => a.price - b.price)
    .slice(0, maxResults);

  return {
    ok: true,
    query: { origin, destination, date, max_results: maxResults },
    count: results.length,
    flights: results,
    summary: results.length
      ? results.map((f, i) => formatFlightLine(f, i)).join("\n")
      : "No flights found for the given route/date in mock dataset.",
  };
}

async function saveFlightsToFile(args = {}) {
  const outputPath = path.resolve(__dirname, "..", "flights found.txt");
  const now = new Date().toISOString();
  const query = args.query || {};
  const flights = Array.isArray(args.flights) ? args.flights : [];

  const header = [
    `Generated at: ${now}`,
    `Route: ${(query.origin || "?") } -> ${(query.destination || "?") }`,
    `Date: ${query.date || "?"}`,
    "",
    "Cheapest flights:",
  ];

  const rows = flights.length
    ? flights.map((f, i) => formatFlightLine(f, i))
    : ["No flights provided."];

  const content = [...header, ...rows, ""].join("\n");
  await fs.writeFile(outputPath, content, "utf8");

  return {
    ok: true,
    file_path: outputPath,
    saved_count: flights.length,
  };
}

module.exports = {
  searchFlights,
  saveFlightsToFile,
};
