# Netwatch — LAN SSH Scanner

A single-page application for scanning the local network, discovering SSH-enabled hosts, and connecting to them via an integrated browser terminal.

## Features

* **Dark UI with green accents** — minimal monospace design using Azeret Mono and Bebas Neue
* **Dynamic host grid** — cards showing hostname (bold) and IP, sorted numerically by IP
* **Intelligent scanning** — detects hosts on the subnet with port 22 open via Nmap
* **Hostname resolution** — resolves hostnames via Nmap reverse DNS with SSH fallback
* **Persistent cache** — displays the last scan results on load
* **Integrated SSH terminal** — click a host card to open an interactive WebSocket terminal in a new tab
* **Quick-Connect bar** — manually enter any IP to open a terminal without scanning
* **Persistent settings** — configure subnet and default SSH credentials saved to `settings.json`
* **Automatic session management** — terminal tab closes automatically when the SSH session ends
* **systemd service support** — run as a daemon with auto-restart on boot

## Technologies

* **Backend**: FastAPI, Uvicorn, Paramiko, python-nmap
* **Frontend**: Vanilla JS, CSS3, HTML5
* **Terminal**: wterm (WASM-based terminal renderer)
* **Network scanning**: Nmap (system dependency)
* **Real-time communication**: WebSockets

## Requirements

* Python 3.8+
* Nmap installed on the system
* Linux (tested) or macOS

## Installation

```
git clone https://github.com/abeggi/terminal
cd terminal
pip install -r requirements.txt
chmod +x manage.sh
```

Install Nmap if not already present:

```
# Debian/Ubuntu
sudo apt update && sudo apt install nmap

# Fedora/RHEL
sudo dnf install nmap

# macOS
brew install nmap
```

Optionally configure initial settings:

```
cp settings.example.json settings.json
# edit settings.json with your subnet and SSH credentials
```

## Usage

### Start the server

```
./manage.sh start
```

The app is available at `http://localhost:8000`.

### Management script commands

| Command | Description |
| --- | --- |
| `./manage.sh start` | Start the server in the background |
| `./manage.sh stop` | Stop the server |
| `./manage.sh status` | Show server status (process + systemd) |
| `sudo ./manage.sh install` | Install the systemd service |
| `sudo ./manage.sh remove` | Remove the systemd service |
| `sudo ./manage.sh enable` | Enable autostart on boot |
| `sudo ./manage.sh disable` | Disable autostart on boot |
| `sudo ./manage.sh service-start` | Start via systemd |
| `sudo ./manage.sh service-stop` | Stop via systemd |
| `tail -f server.log` | View live logs |

### First-time systemd setup

```
sudo ./manage.sh install
sudo ./manage.sh enable
sudo ./manage.sh service-start
```

### Direct systemd commands

```
sudo systemctl start netwatch
sudo systemctl stop netwatch
sudo systemctl restart netwatch
sudo systemctl status netwatch
sudo systemctl disable netwatch   # disable autostart
```

### Web interface

1. Open `http://localhost:8000` in your browser
2. The grid shows hosts from the last scan (if cached)
3. Click **"New scan"** to scan the configured subnet
4. Click **Settings** to configure subnet and SSH credentials
5. Click a host card to open an SSH terminal in a new tab
6. Use the **Quick-Connect** bar to connect directly to any IP

## Configuration

Settings are stored in `settings.json`:

```
{
  "subnet": "192.168.1.0/24",
  "ssh_user": "admin",
  "ssh_password": "password",
  "ssh_port": 22
}
```

You can edit this file directly or via the Settings modal in the UI.

## Troubleshooting

**Nmap not found**

```
which nmap   # verify it's on PATH
```

**SSH connection refused** — verify the target host has SSH enabled, credentials are correct, and the firewall allows port 22.

**WebSocket not connecting** — ensure the server is running and check `server.log` for errors.

## Security

Use a reverse proxy, never expose to the internet.

## License

Released for personal and educational use. See the LICENSE file for details.

---

> This tool is designed for private local networks. Only scan networks you have authorization to access.
