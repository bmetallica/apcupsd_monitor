const express = require("express");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const mqtt = require("mqtt");

const app = express();
const PORT = 3000;
app.use(express.static("public"));
app.use(express.json());

// --- Persistenter Datenordner ---
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const CSV_FILE = path.join(DATA_DIR, "history.csv");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

let config = loadConfig();
let mqttClient = null;

// --- Konfiguration laden ---
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    const def = {
      mqttEnabled: false,
      mqttHost: "",
      mqttUser: "",
      mqttPass: "",
      mqttTopic: "usv/status"
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(def, null, 2));
    return def;
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

// --- MQTT-Verbindung herstellen ---
function connectMQTT() {
  if (!config.mqttEnabled || !config.mqttHost) return;
  const options = {};
  if (config.mqttUser) options.username = config.mqttUser;
  if (config.mqttPass) options.password = config.mqttPass;

  mqttClient = mqtt.connect(`mqtt://${config.mqttHost}`, options);
  mqttClient.on("connect", () => console.log("📡 MQTT verbunden:", config.mqttHost));
  mqttClient.on("error", (err) => console.error("MQTT Fehler:", err));
}

// --- CSV laden ---
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

// --- CSV speichern ---
function saveHistory(history) {
  const lines = history.map(d => `${d.t},${d.BATTV},${d.LINEV},${d.OUTPUTV},${d.ITEMP}`);
  fs.writeFileSync(CSV_FILE, lines.join("\n"));
}

// --- Minütliche Status-Abfrage ---
function fetchAndStoreStatus() {
  const hostIP = process.env.APC_HOST || "127.0.0.1";
  exec(`apcaccess  -h ${hostIP} status`, (err, stdout) => {
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
      TIMELEFT: parseFloat(data.TIMELEFT) || null,
      BCHARGE: parseFloat(data.BCHARGE) || null,
      LOADPCT: parseFloat(data.LOADPCT) || null
    };

    // CSV
    let history = loadHistory();
    history.push(entry);
    const cutoff = now - 24*60*60*1000;
    history = history.filter(e => e.t > cutoff);
    saveHistory(history);

    // --- MQTT senden ---
    if (mqttClient && mqttClient.connected && config.mqttEnabled) {
      mqttClient.publish(config.mqttTopic, JSON.stringify(entry), { retain: true });
      console.log("MQTT gesendet:", config.mqttTopic, entry);
    }
  });
}

// --- Status API ---
app.get("/api/status", (req, res) => {
  const hostIP = process.env.APC_HOST || "127.0.0.1";
  exec(`apcaccess  -h ${hostIP} status`, (err, stdout) => {
    if (err) return res.status(500).json({ error: "Fehler beim Auslesen" });
    const data = {};
    stdout.split("\n").forEach(line => {
      const [key, ...value] = line.split(":");
      if (!key || !value.length) return;
      data[key.trim()] = value.join(":").trim();
    });

    try {
      data.LOG = fs.readFileSync("/var/log/apcupsd.events", "utf8")
        .split("\n").slice(-100).join("\n");
    } catch {
      data.LOG = "(Kein Log verfügbar)";
    }

    res.json(data);
  });
});

// --- Verlauf API ---
app.get("/api/history", (req, res) => {
  const history = loadHistory();
  res.json(history);
});

// --- Config APIs ---
app.get("/api/config", (req, res) => res.json(config));

app.post("/api/config", (req, res) => {
  config = req.body;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  if (mqttClient) mqttClient.end(true);
  mqttClient = null;
  if (config.mqttEnabled) connectMQTT();
  res.json({ success: true });
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`🚀 USV-Webinterface läuft auf http://localhost:${PORT}`);
  if (config.mqttEnabled) connectMQTT();
  fetchAndStoreStatus();
  setInterval(fetchAndStoreStatus, 60 * 1000);
});
