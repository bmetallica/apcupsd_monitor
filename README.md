
# APC UPS Monitor – Webinterface for apcupsd

[🇩🇪 Deutsch](README_de.md)

A modern web interface for monitoring your APC UPS using **apcupsd**. It displays real-time status, battery, load, and voltage charts, as well as event logs.

![Screenshot](https://raw.githubusercontent.com/bmetallica/apcupsd_monitor/refs/heads/main/apc.jpg)


## Features

- Real-time UPS status and event log
- Bar charts for:
  - Estimated runtime (minutes)
  - Battery capacity (%)
  - UPS load (%)
- Line charts (last 24h) for:
  - Battery voltage, output voltage, input voltage
  - Temperature
- Responsive design for desktop and mobile
- CSV-based history storage for long-term charting (24h)
- Systemd service for automatic startup on Debian

## System Requirements

- Debian / Ubuntu
- Node.js (v18+ recommended)
- npm
- `apcupsd` installed and configured

## Installation

1. Clone the repository:

```bash
git clone https://github.com/bmetallica/apcupsd_monitor.git
cd apcupsd_monitor
````

2. Install dependencies:

```bash
npm install
```

3. Copy the systemd service file:

```bash
sudo cp service/apcupsd-web.service /etc/systemd/system/
```

> ⚠️ Edit `/etc/systemd/system/apcupsd-web.service` set the path to your folder and if the Node.js path differs (default uses `/usr/bin/env node`).

4. Reload systemd and enable the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable apcupsd-web.service
sudo systemctl start apcupsd-web.service
```

5. Open your browser and visit:

```
http://<server-ip>:3000
```

## Usage

* The main page shows UPS information on the left and charts/logs on the right.
* Charts are automatically updated every 5 seconds.
* Historical data is stored in `history.csv` in the project directory.

## License

MIT License


