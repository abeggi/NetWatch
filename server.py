"""
server.py – Network Scanner SPA backend
FastAPI + WebSockets + Paramiko
"""

import asyncio
import ipaddress
import json
import logging
import os
import re
import socket
import subprocess
from pathlib import Path
from typing import Optional

import paramiko
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# ─── Logging ────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# ─── App ─────────────────────────────────────────────────────────────────────
app = FastAPI(title="Network Scanner")

STATIC_DIR = Path(__file__).parent / "static"
from fastapi.staticfiles import StaticFiles

class NoCacheStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

app.mount("/static", NoCacheStaticFiles(directory=STATIC_DIR), name="static")

# ─── Persistent scan cache ───────────────────────────────────────────────────
SCAN_CACHE_FILE = Path(__file__).parent / "scan_cache.json"

def load_scan_cache() -> list[dict]:
    """Load scan cache from JSON file."""
    try:
        if SCAN_CACHE_FILE.exists():
            data = json.loads(SCAN_CACHE_FILE.read_text())
            if isinstance(data, list):
                log.info(f"Loaded scan cache from {SCAN_CACHE_FILE} ({len(data)} hosts)")
                return data
    except Exception as e:
        log.warning(f"Could not load scan cache: {e}")
    return []

def save_scan_cache(data: list[dict]) -> None:
    """Save scan cache to JSON file."""
    try:
        SCAN_CACHE_FILE.write_text(json.dumps(data, indent=2))
        log.info(f"Saved scan cache to {SCAN_CACHE_FILE} ({len(data)} hosts)")
    except Exception as e:
        log.error(f"Could not save scan cache: {e}")

# ─── In-memory cache ─────────────────────────────────────────────────────────
_scan_cache: list[dict] = load_scan_cache()   # [{"ip": ..., "hostname": ...}]


def _ip_key(host: dict) -> int:
    try:
        return int(ipaddress.ip_address(host["ip"]))
    except ValueError:
        return 0


# ─── Root → serve index.html ─────────────────────────────────────────────────
@app.get("/")
async def root():
    return FileResponse(STATIC_DIR / "index.html")


# ─── Cache endpoint ───────────────────────────────────────────────────────────
@app.get("/api/cache")
async def get_cache():
    return JSONResponse(content=_scan_cache)


# ─── Detect local subnet ─────────────────────────────────────────────────────
def _default_subnet() -> str:
    """Best-effort: derive /24 subnet from local IP."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        parts = ip.rsplit(".", 1)
        return f"{parts[0]}.0/24"
    except Exception:
        return "192.168.1.0/24"


# ─── Settings ────────────────────────────────────────────────────────────────
SETTINGS_FILE = Path(__file__).parent / "settings.json"
SETTINGS_EXAMPLE_FILE = Path(__file__).parent / "settings.example.json"

def get_settings():
    if SETTINGS_FILE.exists():
        try:
            return json.loads(SETTINGS_FILE.read_text())
        except Exception as e:
            log.warning(f"Could not read settings.json: {e}. Using defaults.")
    # If settings.json doesn't exist or is invalid, create it with default values
    default_settings = {
        "subnet": _default_subnet(),
        "ssh_user": "root",
        "ssh_password": "",
        "ssh_port": 22
    }
    # Write default settings to file
    try:
        SETTINGS_FILE.write_text(json.dumps(default_settings, indent=2))
        log.info(f"Created default settings file at {SETTINGS_FILE}")
    except Exception as e:
        log.error(f"Could not write settings.json: {e}")
    return default_settings

@app.get("/api/settings")
async def api_get_settings():
    return JSONResponse(content=get_settings())

@app.post("/api/settings")
async def api_post_settings(request: Request):
    data = await request.json()
    try:
        # Validate required fields
        required_fields = ["subnet", "ssh_user", "ssh_port"]
        for field in required_fields:
            if field not in data:
                return JSONResponse(
                    content={"status": "error", "message": f"Missing field: {field}"},
                    status_code=400
                )
        SETTINGS_FILE.write_text(json.dumps(data, indent=2))
        log.info("Settings updated successfully")
        return JSONResponse(content={"status": "ok"})
    except Exception as e:
        log.error(f"Error saving settings: {e}")
        return JSONResponse(
            content={"status": "error", "message": str(e)},
            status_code=500
        )


# ─── SSH Hostname Fallback ───────────────────────────────────────────────────
async def _resolve_hostname_via_ssh(ip: str, ws: WebSocket):
    settings = get_settings()
    user = settings.get("ssh_user", "root")
    pwd = settings.get("ssh_password", "")
    port = int(settings.get("ssh_port", 22))

    if not user:
        return

    loop = asyncio.get_event_loop()
    def _do_ssh():
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            ssh.connect(ip, port=port, username=user, password=pwd, timeout=2.5, banner_timeout=2.5, auth_timeout=3)
            stdin, stdout, stderr = ssh.exec_command("hostname", timeout=2)
            raw = stdout.read().decode()
            # Strip ANSI escape codes
            clean = re.sub(r'\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])', '', raw)
            # Return the first line that looks like a valid hostname
            for line in clean.splitlines():
                line = line.strip()
                if re.match(r'^[a-zA-Z0-9][a-zA-Z0-9\-\.]*$', line):
                    return line
            return None
        except Exception as e:
            log.debug(f"SSH hostname resolve failed for {ip}: {e}")
            return None
        finally:
            ssh.close()

    hostname = await loop.run_in_executor(None, _do_ssh)
    if hostname:
        updated = False
        for h in _scan_cache:
            if h["ip"] == ip:
                h["hostname"] = hostname
                updated = True
                break
        if updated:
            # Persist the updated cache to disk
            save_scan_cache(_scan_cache)
        try:
            await ws.send_text(json.dumps({"type": "update_host", "ip": ip, "hostname": hostname}))
            log.info(f"Resolved hostname for {ip} via SSH: {hostname}")
        except Exception:
            pass


# ─── WebSocket: /ws/scan ─────────────────────────────────────────────────────
@app.websocket("/ws/scan")
async def ws_scan(websocket: WebSocket, subnet: Optional[str] = None):
    await websocket.accept()
    global _scan_cache
    _scan_cache = []

    # Use setting if not provided explicitly in URL
    if not subnet:
        subnet = get_settings().get("subnet") or _default_subnet()
    subnet = subnet.strip()
    log.info(f"Scan started: {subnet}")

    # Validate subnet
    try:
        net = ipaddress.ip_network(subnet, strict=False)
    except ValueError:
        await websocket.send_text(json.dumps({"type": "error", "message": f"Subnet non valida: {subnet}"}))
        await websocket.close()
        return

    discovered: dict[str, dict] = {}
    resolution_tasks = set()

    async def send_progress(pct: int):
        try:
            await websocket.send_text(json.dumps({"type": "progress", "percent": pct}))
        except Exception:
            pass

    # ── Port scan: solo host con porta 22 aperta ────────────────────────────
    try:
        proc = await asyncio.create_subprocess_exec(
            "nmap", "-p", "22", "--open", "-T4", "-R", str(net),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except FileNotFoundError:
        await websocket.send_text(json.dumps({"type": "error", "message": "nmap non trovato. Installa nmap con: sudo apt install nmap"}))
        await websocket.close()
        return

    # Parse nmap output line by line
    current_ip: Optional[str] = None
    current_hostname: Optional[str] = None
    total_hosts = net.num_addresses
    seen_count = 0

    await send_progress(5)

    while True:
        line_bytes = await proc.stdout.readline()
        if not line_bytes:
            break
        line = line_bytes.decode(errors="replace").strip()

        # "Nmap scan report for hostname (ip)" or "Nmap scan report for ip"
        m = re.match(r"Nmap scan report for (?:(.+?) \()?([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)\)?", line)
        if m:
            current_hostname = m.group(1)  # may be None
            current_ip = m.group(2)
            seen_count += 1
            pct = min(5 + int(90 * seen_count / max(total_hosts, 1)), 94)
            await send_progress(pct)

        # "22/tcp open ssh" → porta 22 confermata aperta
        if current_ip and re.search(r"22/tcp\s+open", line):
            if current_ip not in discovered:
                host_entry = {"ip": current_ip, "hostname": current_hostname or current_ip}
                discovered[current_ip] = host_entry
                _scan_cache.append(host_entry)
                _scan_cache.sort(key=_ip_key)
                msg = {"type": "host", "ip": current_ip, "hostname": current_hostname or ""}
                try:
                    await websocket.send_text(json.dumps(msg))
                except Exception:
                    break
                
                # Se l'hostname non è stato risolto o è uguale all'IP, proviamo via SSH in background
                if not current_hostname or current_hostname == current_ip:
                    task = asyncio.create_task(_resolve_hostname_via_ssh(current_ip, websocket))
                    resolution_tasks.add(task)
                    task.add_done_callback(resolution_tasks.discard)

            current_ip = None
            current_hostname = None

    await proc.wait()
    
    # Attendiamo che tutte le risoluzioni SSH finiscano (max 10 secondi per sicurezza)
    if resolution_tasks:
        log.info(f"Waiting for {len(resolution_tasks)} hostname resolution tasks...")
        await asyncio.wait(resolution_tasks, timeout=10)
    
    await send_progress(100)

    # Save the updated cache to disk
    save_scan_cache(_scan_cache)

    try:
        await websocket.send_text(json.dumps({"type": "done", "count": len(discovered)}))
    except Exception:
        pass
    log.info(f"Scan completed: {len(discovered)} hosts found, cache saved")


# ─── WebSocket: /ws/ssh/{host} ───────────────────────────────────────────────
@app.websocket("/ws/ssh/{host}")
async def ws_ssh(websocket: WebSocket, host: str):
    await websocket.accept()
    log.info(f"SSH connection request to {host}")

    # Read credentials from first message: {"user": ..., "password": ..., "port": ...}
    # (or we prompt inside xterm.js by relaying a prompt)
    try:
        creds_raw = await asyncio.wait_for(websocket.receive_text(), timeout=30)
        creds = json.loads(creds_raw)
    except asyncio.TimeoutError:
        await _ws_write(websocket, "\r\nTimeout attendendo credenziali.\r\n")
        await websocket.close()
        return
    except Exception:
        # Not JSON – maybe the client sent a resize; try to prompt interactively
        creds = {}

    username  = creds.get("user", "")
    password  = creds.get("password", "")
    port      = int(creds.get("port", 22))
    cols      = int(creds.get("cols", 80))
    rows      = int(creds.get("rows", 24))

    if not username:
        await _ws_write(websocket, "Credenziali mancanti (user/password).\r\n")
        await websocket.close()
        return

    # ── Paramiko SSH ──────────────────────────────────────────────────────────
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    try:
        ssh.connect(host, port=port, username=username, password=password, timeout=10,
                    banner_timeout=15, auth_timeout=15)
    except paramiko.AuthenticationException:
        await _ws_write(websocket, "\r\n\x1b[31mAutenticazione fallita.\x1b[0m\r\n")
        await websocket.send_text(json.dumps({"type": "close"}))
        await websocket.close()
        return
    except Exception as e:
        await _ws_write(websocket, f"\r\n\x1b[31mErrore di connessione: {e}\x1b[0m\r\n")
        await websocket.send_text(json.dumps({"type": "close"}))
        await websocket.close()
        return

    channel = ssh.invoke_shell(term="xterm-256color", width=cols, height=rows)
    channel.setblocking(False)

    log.info(f"SSH shell opened to {host}")

    loop = asyncio.get_event_loop()

    async def ssh_reader():
        """Read from SSH channel → send to WebSocket."""
        try:
            while True:
                await asyncio.sleep(0.02)
                if channel.recv_ready():
                    data = channel.recv(4096)
                    if not data:
                        break
                    await websocket.send_bytes(data)
                if channel.exit_status_ready():
                    break
        except Exception:
            pass

    async def ws_reader():
        """Read from WebSocket → write to SSH channel."""
        try:
            while True:
                msg = await websocket.receive()
                if "text" in msg:
                    txt = msg["text"]
                    # Handle resize
                    try:
                        obj = json.loads(txt)
                        if obj.get("type") == "resize":
                            channel.resize_pty(width=obj.get("cols", 80), height=obj.get("rows", 24))
                        continue
                    except Exception:
                        pass
                    channel.send(txt.encode())
                elif "bytes" in msg:
                    channel.send(msg["bytes"])
        except WebSocketDisconnect:
            pass
        except Exception:
            pass

    # Run both readers concurrently; stop when either finishes
    reader_task = asyncio.create_task(ssh_reader())
    writer_task = asyncio.create_task(ws_reader())

    done, pending = await asyncio.wait(
        [reader_task, writer_task],
        return_when=asyncio.FIRST_COMPLETED,
    )
    for t in pending:
        t.cancel()

    try:
        channel.close()
        ssh.close()
    except Exception:
        pass

    # Notify the browser tab to close
    try:
        await websocket.send_text(json.dumps({"type": "close"}))
        await asyncio.sleep(0.3)
        await websocket.close()
    except Exception:
        pass

    log.info(f"SSH session to {host} closed")


async def _ws_write(ws: WebSocket, text: str):
    try:
        await ws.send_bytes(text.encode())
    except Exception:
        pass


# ─── Entry-point ─────────────────────────────────────────────────────────────
import argparse
import sys

def main():
    parser = argparse.ArgumentParser(description="Network Scanner SPA backend")
    parser.add_argument("--daemon", action="store_true", help="Run as daemon (background)")
    parser.add_argument("--pidfile", default="/tmp/netscanner.pid", help="Path to PID file (default: /tmp/netscanner.pid)")
    args = parser.parse_args()

    if args.daemon:
        # Daemonize using double fork
        try:
            pid = os.fork()
            if pid > 0:
                # Parent exits
                sys.exit(0)
        except OSError as e:
            sys.stderr.write(f"Fork failed: {e}\n")
            sys.exit(1)

        # Decouple from parent environment
        os.chdir("/")
        os.setsid()
        os.umask(0)

        try:
            pid = os.fork()
            if pid > 0:
                # Parent exits
                sys.exit(0)
        except OSError as e:
            sys.stderr.write(f"Second fork failed: {e}\n")
            sys.exit(1)

        # Redirect standard file descriptors
        sys.stdout.flush()
        sys.stderr.flush()
        si = open(os.devnull, 'r')
        so = open(os.devnull, 'a+')
        se = open(os.devnull, 'a+')
        os.dup2(si.fileno(), sys.stdin.fileno())
        os.dup2(so.fileno(), sys.stdout.fileno())
        os.dup2(se.fileno(), sys.stderr.fileno())

        # Write PID file
        with open(args.pidfile, "w") as f:
            f.write(str(os.getpid()))

    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")

if __name__ == "__main__":
    main()
