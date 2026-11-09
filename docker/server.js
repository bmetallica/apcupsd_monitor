const express = require("express");
const { execFile } = require("child_process");
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

const POLL_INTERVAL_MS = 5000;       // Netzausfall wird innerhalb von 5 s erkannt
const HISTORY_CYCLE_TICKS = 12;      // 12 x 5 s = jede Minute ein Historien-Eintrag
const DEFAULT_MQTT_INTERVAL_S = 60;
const APCACCESS_TIMEOUT_MS = 10000;
const APCACCESS_ARGS = process.env.APC_HOST
  ? ["-h", process.env.APC_HOST, "status"]
  : ["status"];

// Werte mit Einheit ("230.0 Volts", "29.2 C Internal") werden als Zahl gesendet.
// Reine Ziffernfolgen wie SERIALNO bleiben Text, sonst gingen fuehrende Nullen verloren.
const VALUE_WITH_UNIT = /^(-?\d+(?:\.\d+)?)\s+(?:Volts|Percent|Minutes|Seconds|Hz|Watts|VA|Amps|C|F)\b/;
const UNITLESS_NUMERIC_KEYS = new Set(["NUMXFERS", "EXTBATTS", "BADBATTS"]);

let config = loadConfig();
let mqttClient = null;
let lastData = null;
let lastStatus = null;
let lastKnownPowerState = null;
let upsAvailable = null;
let pollRunning = false;
let pollTick = 0;

// --- Konfiguration laden ---
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    const def = {
      mqttEnabled: false,
      mqttHost: "",
      mqttUser: "",
      mqttPass: "",
      mqttTopic: "usv/status",
      mqttInterval: DEFAULT_MQTT_INTERVAL_S
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(def, null, 2));
    return def;
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

// --- MQTT-Verbindung herstellen ---
function connectMQTT() {
  if (!config.mqttEnabled || !config.mqttHost) return;
  const options = {
    will: {
      topic: `${baseTopic()}/available`,
      payload: Buffer.from("offline"),
      qos: 1,
      retain: true
    }
  };
  if (config.mqttUser) options.username = config.mqttUser;
  if (config.mqttPass) options.password = config.mqttPass;

  mqttClient = mqtt.connect(`mqtt://${config.mqttHost}`, options);
  mqttClient.on("connect", () => {
    console.log("📡 MQTT verbunden:", config.mqttHost);
    // Nach einem Verbindungsabbruch sofort den aktuellen Stand nachliefern
    if (lastData) publishAll(lastData);
    else publishUnavailable();
  });
  mqttClient.on("error", (err) => console.error("MQTT Fehler:", err));
}

// Sendeintervall in Sekunden, mindestens eine Abfragerunde
function normalizeMqttInterval(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_MQTT_INTERVAL_S;
  return Math.max(POLL_INTERVAL_MS / 1000, Math.round(seconds));
}

function baseTopic() {
  return (config.mqttTopic || "usv/status").replace(/\/+$/, "");
}

// --- apcaccess auslesen ---
function readUpsStatus(callback) {
  execFile("apcaccess", APCACCESS_ARGS, { timeout: APCACCESS_TIMEOUT_MS }, (err, stdout) => {
    if (err) return callback(err);
    const data = {};
    stdout.split("\n").forEach(line => {
      const [key, ...value] = line.split(":");
      if (!key || !value.length) return;
      data[key.trim()] = value.join(":").trim();
    });
    callback(null, data);
  });
}

// "battery", "mains" oder "unknown" (z.B. COMMLOST, wenn die USV nicht antwortet)
function getPowerState(status) {
  const flags = (status || "").split(/\s+/);
  if (flags.includes("ONBATT")) return "battery";
  if (flags.includes("ONLINE")) return "mains";
  return "unknown";
}

function parseMqttValue(key, raw) {
  const match = raw.match(VALUE_WITH_UNIT);
  if (match) return parseFloat(match[1]);
  if (UNITLESS_NUMERIC_KEYS.has(key) && /^\d+$/.test(raw)) return parseInt(raw, 10);
  return raw;
}

function buildHistoryEntry(data, t) {
  return {
    t,
    BATTV: parseFloat(data.BATTV) || null,
    LINEV: parseFloat(data.LINEV) || null,
    OUTPUTV: parseFloat(data.OUTPUTV) || null,
    ITEMP: parseFloat(data.ITEMP) || null,
    TIMELEFT: parseFloat(data.TIMELEFT) || null,
    BCHARGE: parseFloat(data.BCHARGE) || null,
    LOADPCT: parseFloat(data.LOADPCT) || null
  };
}

// --- MQTT: alle Werte senden ---
function publishAll(data) {
  if (!mqttClient || !mqttClient.connected || !config.mqttEnabled) return;
  const base = baseTopic();
  const values = {};
  for (const [key, raw] of Object.entries(data)) {
    // Themen duerfen keine Leerzeichen enthalten ("END APC" -> "END_APC")
    const name = key.replace(/[^A-Za-z0-9_-]/g, "_");
    values[name] = parseMqttValue(key, raw);
    mqttClient.publish(`${base}/${name}`, String(values[name]), { retain: true });
  }

  const powerState = getPowerState(data.STATUS);
  const onBattery = powerState === "unknown" ? null : powerState === "battery";
  const stateOptions = { qos: 1, retain: true };
  mqttClient.publish(`${base}/available`, "online", stateOptions);
  mqttClient.publish(`${base}/power_state`, powerState, stateOptions);
  // Bei unbekanntem Zustand bleibt der letzte gesicherte Wert stehen
  if (onBattery !== null) mqttClient.publish(`${base}/on_battery`, String(onBattery), stateOptions);

  const summary = {
    ...buildHistoryEntry(data, Date.now()),
    ...values,
    on_battery: onBattery,
    power_state: powerState
  };
  mqttClient.publish(base, JSON.stringify(summary), { retain: true });
  console.log("MQTT gesendet:", base, `(${Object.keys(values).length} Werte, ${powerState})`);
}

function publishUnavailable() {
  if (!mqttClient || !mqttClient.connected || !config.mqttEnabled) return;
  const base = baseTopic();
  const stateOptions = { qos: 1, retain: true };
  mqttClient.publish(`${base}/available`, "offline", stateOptions);
  mqttClient.publish(`${base}/power_state`, "unknown", stateOptions);
}

// Einmalige Meldung beim Wechsel Netz <-> Batterie. Ohne Broker-Verbindung reiht
// der MQTT-Client sie ein und stellt sie beim Reconnect zu.
function handlePowerTransition(data) {
  const state = getPowerState(data.STATUS);
  if (state === "unknown") return;
  if (lastKnownPowerState && state !== lastKnownPowerState) {
    const event = state === "battery" ? "power_lost" : "power_restored";
    console.log("USV-Ereignis:", event, data.STATUS);
    if (mqttClient && config.mqttEnabled) {
      mqttClient.publish(`${baseTopic()}/event`, JSON.stringify({
        event,
        t: Date.now(),
        STATUS: data.STATUS,
        BCHARGE: parseMqttValue("BCHARGE", data.BCHARGE || ""),
        TIMELEFT: parseMqttValue("TIMELEFT", data.TIMELEFT || "")
      }), { qos: 1, retain: false });
    }
  }
  lastKnownPowerState = state;
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

function storeHistory(data) {
  const now = Date.now();
  let history = loadHistory();
  history.push(buildHistoryEntry(data, now));
  const cutoff = now - 24*60*60*1000;
  history = history.filter(e => e.t > cutoff);
  saveHistory(history);
}

// --- Regelmaessige Status-Abfrage ---
function pollUps() {
  if (pollRunning) return;
  pollRunning = true;
  readUpsStatus((err, data) => {
    pollRunning = false;
    const tick = pollTick++;
    const isHistoryCycle = tick % HISTORY_CYCLE_TICKS === 0;
    const intervalMs = normalizeMqttInterval(config.mqttInterval) * 1000;
    const isMqttCycle = tick % Math.max(1, Math.round(intervalMs / POLL_INTERVAL_MS)) === 0;

    if (err) {
      if (upsAvailable !== false) {
        console.error("Fehler beim Auslesen:", err.message);
        publishUnavailable();
      }
      upsAvailable = false;
      lastData = null;
      return;
    }

    if (isHistoryCycle) storeHistory(data);

    const mustPublish = isMqttCycle || data.STATUS !== lastStatus || upsAvailable !== true;
    upsAvailable = true;
    lastData = data;
    lastStatus = data.STATUS;
    handlePowerTransition(data);
    if (mustPublish) publishAll(data);
  });
}

// --- Status API ---
app.get("/api/status", (req, res) => {
  readUpsStatus((err, data) => {
    if (err) return res.status(500).json({ error: "Fehler beim Auslesen" });

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
  config = { ...req.body, mqttInterval: normalizeMqttInterval(req.body.mqttInterval) };
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
  pollUps();
  setInterval(pollUps, POLL_INTERVAL_MS);
});
