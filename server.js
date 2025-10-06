const express = require("express");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;
app.use(express.static("public"));

const CSV_FILE = path.join(__dirname, "history.csv");

// CSV laden und nur letzte 24h behalten
function loadHistory() {
  let h = [];
  if (fs.existsSync(CSV_FILE)) {
    h = fs.readFileSync(CSV_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(line => {
        const [t, BATTV, LINEV, OUTPUTV, ITEMP] = line.split(",");
        return {
          t: parseInt(t),
          BATTV: parseFloat(BATTV),
          LINEV: parseFloat(LINEV),
          OUTPUTV: parseFloat(OUTPUTV),
          ITEMP: parseFloat(ITEMP)
        };
      });
  }
  const cutoff = Date.now() - 24*60*60*1000;
  return h.filter(e => e.t > cutoff);
}

// CSV neu schreiben
function saveHistory(history) {
  const lines = history.map(d => `${d.t},${d.BATTV},${d.LINEV},${d.OUTPUTV},${d.ITEMP}`);
  fs.writeFileSync(CSV_FILE, lines.join("\n"));
}

// Minütliche Status-Abfrage
function fetchAndStoreStatus() {
  exec("apcaccess status", (err, stdout) => {
    if (err) return console.error("Fehler beim Auslesen:", err);

    const data = {};
    stdout.split("\n").forEach(line => {
      const [key, ...value] = line.split(":");
      if (!key || !value.length) return;
      data[key.trim()] = value.join(":").trim();
    });

    const now = Date.now();
    const entry = {
      t: now,
      BATTV: parseFloat(data.BATTV) || null,
      LINEV: parseFloat(data.LINEV) || null,
      OUTPUTV: parseFloat(data.OUTPUTV) || null,
      ITEMP: parseFloat(data.ITEMP) || null,
    };

    // CSV einlesen
    let history = loadHistory();
    history.push(entry);

    // alte Einträge löschen
    const cutoff = now - 24*60*60*1000;
    history = history.filter(e => e.t > cutoff);

    // CSV neu schreiben
    saveHistory(history);
  });
}

// Status API
app.get("/api/status", (req, res) => {
  exec("apcaccess status", (err, stdout) => {
    if (err) return res.status(500).json({ error: "Fehler beim Auslesen" });
    const data = {};
    stdout.split("\n").forEach(line => {
      const [key, ...value] = line.split(":");
      if (!key || !value.length) return;
      data[key.trim()] = value.join(":").trim();
    });

    // Log lesen
    try {
      data.LOG = fs.readFileSync("/var/log/apcupsd.events", "utf8").split("\n").slice(-100).join("\n");
    } catch {
      data.LOG = "(Kein Log verfügbar)";
    }

    res.json(data);
  });
});

// Verlauf API
app.get("/api/history", (req, res) => {
  const history = loadHistory();
  res.json(history);
});

app.listen(PORT, () => console.log(`🚀 USV-Webinterface läuft auf http://localhost:${PORT}`));

// Minütlich automatisch Status abrufen
fetchAndStoreStatus(); // sofort beim Start
setInterval(fetchAndStoreStatus, 60*1000);
