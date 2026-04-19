#!/usr/bin/env bash
# =============================================================================
# manage.sh — Netwatch management script
# Gestione dell'app come processo (PID) e come servizio systemd
#
# Uso: ./manage.sh <comando>
# =============================================================================

set -euo pipefail

# ─── Configurazione ──────────────────────────────────────────────────────────

SERVICE_NAME="netwatch"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# Directory dello script = directory del repo
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ENTRY="${SCRIPT_DIR}/server.py"
PID_FILE="${SCRIPT_DIR}/netwatch.pid"
LOG_FILE="${SCRIPT_DIR}/server.log"

# Python da usare (venv se presente, altrimenti python3 di sistema)
if [[ -f "${SCRIPT_DIR}/venv/bin/python" ]]; then
    PYTHON="${SCRIPT_DIR}/venv/bin/python"
elif [[ -f "${SCRIPT_DIR}/.venv/bin/python" ]]; then
    PYTHON="${SCRIPT_DIR}/.venv/bin/python"
else
    PYTHON="python3"
fi

# ─── Colori ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()      { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
die()     { error "$*"; exit 1; }

require_root() {
    [[ $EUID -eq 0 ]] || die "Questo comando richiede i privilegi di root (usa sudo)."
}

# ─── Funzioni PID ────────────────────────────────────────────────────────────

_pid_running() {
    local pid_file="${1:-$PID_FILE}"
    [[ -f "$pid_file" ]] || return 1
    local pid
    pid=$(cat "$pid_file" 2>/dev/null) || return 1
    [[ -n "$pid" ]] || return 1
    kill -0 "$pid" 2>/dev/null
}

_get_pid() {
    cat "$PID_FILE" 2>/dev/null || echo ""
}

# ─── Comandi ─────────────────────────────────────────────────────────────────

cmd_start() {
    if _pid_running; then
        warn "Il processo è già in esecuzione (PID $(_get_pid))."
        return 0
    fi

    info "Avvio di ${SERVICE_NAME}..."
    nohup "$PYTHON" "$APP_ENTRY" >> "$LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"

    # Breve attesa per verificare che il processo non sia crashato subito
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
        ok "Avviato (PID ${pid}). Log: ${LOG_FILE}"
        ok "Interfaccia disponibile su http://localhost:8000"
    else
        rm -f "$PID_FILE"
        die "Il processo è terminato subito dopo l'avvio. Controlla: tail ${LOG_FILE}"
    fi
}

cmd_stop() {
    if ! _pid_running; then
        warn "Nessun processo in esecuzione trovato."
        return 0
    fi

    local pid
    pid=$(_get_pid)
    info "Arresto del processo (PID ${pid})..."
    kill -TERM "$pid" 2>/dev/null || true

    local i=0
    while kill -0 "$pid" 2>/dev/null && (( i < 10 )); do
        sleep 1
        (( i++ ))
    done

    if kill -0 "$pid" 2>/dev/null; then
        warn "Il processo non ha risposto a SIGTERM, invio SIGKILL..."
        kill -KILL "$pid" 2>/dev/null || true
    fi

    rm -f "$PID_FILE"
    ok "Processo arrestato."
}

cmd_status() {
    echo ""
    echo -e "${BOLD}── Stato processo (PID file) ──────────────────────────${NC}"
    if _pid_running; then
        local pid
        pid=$(_get_pid)
        ok "In esecuzione — PID ${pid}"
        echo ""
        # Info processo da /proc
        if [[ -f "/proc/${pid}/status" ]]; then
            local rss
            rss=$(awk '/VmRSS/{print $2, $3}' "/proc/${pid}/status" 2>/dev/null || echo "N/A")
            echo -e "  Memoria RSS : ${rss}"
        fi
        local uptime_s
        uptime_s=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ' || echo "?")
        echo -e "  Uptime      : ${uptime_s}s"
        echo -e "  Log         : ${LOG_FILE}"
    else
        warn "Non in esecuzione."
        [[ -f "$PID_FILE" ]] && warn "PID file residuo rimosso." && rm -f "$PID_FILE"
    fi

    echo ""
    echo -e "${BOLD}── Stato servizio systemd ─────────────────────────────${NC}"
    if [[ -f "$UNIT_FILE" ]]; then
        systemctl is-active --quiet "$SERVICE_NAME" \
            && ok  "systemd: attivo" \
            || warn "systemd: non attivo"
        systemctl is-enabled --quiet "$SERVICE_NAME" \
            && info "Autostart: abilitato" \
            || info "Autostart: disabilitato"
        echo ""
        systemctl status "$SERVICE_NAME" --no-pager -l 2>/dev/null || true
    else
        info "Unit file non installato (usa: sudo ./manage.sh install)."
    fi
    echo ""
}

cmd_install() {
    require_root

    if [[ -f "$UNIT_FILE" ]]; then
        warn "Il servizio è già installato. Uso 'remove' prima di reinstallare."
        return 1
    fi

    # Risolvi l'utente che possiede il repo (non root)
    local run_user
    run_user=$(stat -c '%U' "$SCRIPT_DIR")
    [[ "$run_user" == "root" ]] && run_user="${SUDO_USER:-root}"

    info "Installazione del servizio systemd come utente '${run_user}'..."
    info "Unit file: ${UNIT_FILE}"

    cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Netwatch — LAN SSH Scanner
Documentation=https://github.com/abeggi/terminal
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${run_user}
WorkingDirectory=${SCRIPT_DIR}
ExecStart=${PYTHON} ${APP_ENTRY}
Restart=on-failure
RestartSec=5s
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    ok "Servizio installato."
    info "Per abilitare l'autostart: sudo ./manage.sh enable"
    info "Per avviarlo subito:       sudo ./manage.sh service-start"
}

cmd_remove() {
    require_root

    if [[ ! -f "$UNIT_FILE" ]]; then
        warn "Unit file non trovato, niente da rimuovere."
        return 0
    fi

    # Ferma e disabilita prima di rimuovere
    systemctl is-active --quiet "$SERVICE_NAME" && systemctl stop "$SERVICE_NAME" || true
    systemctl is-enabled --quiet "$SERVICE_NAME" && systemctl disable "$SERVICE_NAME" || true

    rm -f "$UNIT_FILE"
    systemctl daemon-reload
    ok "Servizio rimosso."
}

cmd_enable() {
    require_root
    [[ -f "$UNIT_FILE" ]] || die "Servizio non installato. Usa prima: sudo ./manage.sh install"
    systemctl enable "$SERVICE_NAME"
    ok "Autostart abilitato."
}

cmd_disable() {
    require_root
    [[ -f "$UNIT_FILE" ]] || die "Servizio non installato."
    systemctl disable "$SERVICE_NAME"
    ok "Autostart disabilitato."
}

cmd_service_start() {
    require_root
    [[ -f "$UNIT_FILE" ]] || die "Servizio non installato. Usa prima: sudo ./manage.sh install"
    systemctl start "$SERVICE_NAME"
    ok "Servizio avviato via systemd."
    systemctl status "$SERVICE_NAME" --no-pager -l
}

cmd_service_stop() {
    require_root
    [[ -f "$UNIT_FILE" ]] || die "Servizio non installato."
    systemctl stop "$SERVICE_NAME"
    ok "Servizio fermato via systemd."
}

# ─── Help ─────────────────────────────────────────────────────────────────────

usage() {
    echo -e "
${BOLD}manage.sh${NC} — Netwatch management script

${BOLD}Processo in background (senza systemd):${NC}
  ./manage.sh start          Avvia il processo in background
  ./manage.sh stop           Ferma il processo
  ./manage.sh status         Mostra lo stato (processo + systemd)

${BOLD}Servizio systemd (richiedono sudo):${NC}
  sudo ./manage.sh install        Installa il servizio systemd
  sudo ./manage.sh remove         Rimuove il servizio systemd
  sudo ./manage.sh enable         Abilita l'autostart all'avvio
  sudo ./manage.sh disable        Disabilita l'autostart
  sudo ./manage.sh service-start  Avvia tramite systemd
  sudo ./manage.sh service-stop   Ferma tramite systemd

${BOLD}Workflow tipico (prima installazione):${NC}
  sudo ./manage.sh install
  sudo ./manage.sh enable
  sudo ./manage.sh service-start
"
}

# ─── Dispatcher ──────────────────────────────────────────────────────────────

COMMAND="${1:-help}"

case "$COMMAND" in
    start)          cmd_start ;;
    stop)           cmd_stop ;;
    status)         cmd_status ;;
    install)        cmd_install ;;
    remove)         cmd_remove ;;
    enable)         cmd_enable ;;
    disable)        cmd_disable ;;
    service-start)  cmd_service_start ;;
    service-stop)   cmd_service_stop ;;
    help|--help|-h) usage ;;
    *)
        error "Comando sconosciuto: '${COMMAND}'"
        usage
        exit 1
        ;;
esac
