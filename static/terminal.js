/* ─── terminal.js – SSH WebSocket bridge via wterm ──────────── */
import { WTerm } from "/static/wterm/wterm.js";

(async function () {
    'use strict';

    const params   = new URLSearchParams(location.search);
    const host     = params.get('host') || '';
    const urlPort  = params.get('port') || '';
    const hostLabel = document.getElementById('host-label');
    const connDot  = document.getElementById('conn-dot');
    const connText = document.getElementById('conn-text');
    const modal    = document.getElementById('creds-modal');
    const modalHost = document.getElementById('modal-host');
    const submitBtn = document.getElementById('creds-submit');
    const userInput = document.getElementById('creds-user');
    const passInput = document.getElementById('creds-pass');
    const portInput = document.getElementById('creds-port');

    hostLabel.textContent = host || 'unknown';
    document.title = `SSH – ${host}`;
    if (modalHost) modalHost.textContent = host;

    if (!host) {
        if (connText) connText.textContent = 'Host mancante';
        if (connDot) connDot.className = 'disconnected';
        if (modal) modal.style.display = 'none';
        return;
    }

    /* ── Pre-fill credentials ──────────────────────────────────── */
    async function loadDefaultSettings() {
        try {
            const res = await fetch('/api/settings');
            if (res.ok) {
                const data = await res.json();
                if (userInput) userInput.value = data.ssh_user || 'root';
                if (passInput) passInput.value = data.ssh_password || '';
                // URL param takes priority over settings
                if (portInput) portInput.value = urlPort || data.ssh_port || 22;
            }
        } catch {
            if (portInput && urlPort) portInput.value = urlPort;
        }
    }

    loadDefaultSettings();

    /* ── Init wterm ───────────────────────────────────────────── */
    const termEl = document.getElementById('terminal');
    const term = new WTerm(termEl, {
        autoResize: true,
        onData: (data) => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
        },
        onResize: (cols, rows) => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'resize', cols, rows }));
            }
        },
        onTitle: (title) => {
            document.title = title ? `${title} – SSH` : `SSH – ${host}`;
        },
    });

    await term.init();

    let ws = null;

    /* ── Connect to SSH WebSocket ────────────────────────────────── */
    function connect(username, password, port) {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(`${proto}://${location.host}/ws/ssh/${encodeURIComponent(host)}`);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
            ws.send(JSON.stringify({
                user: username,
                password: password,
                port: port,
                cols: term.cols,
                rows: term.rows,
            }));
            connDot.className = 'connected';
            if (connText) connText.textContent = 'Connesso';
            term.write(`\x1b[32mConnessione a ${host}:${port} come ${username}…\x1b[0m\r\n`);
        };

        ws.onmessage = (ev) => {
            if (ev.data instanceof ArrayBuffer) {
                term.write(new Uint8Array(ev.data));
                return;
            }
            try {
                const msg = JSON.parse(ev.data);
                if (msg.type === 'close') {
                    term.write('\r\n\x1b[33m[Sessione SSH terminata. Chiusura tab…]\x1b[0m');
                    setTimeout(() => window.close(), 1200);
                    return;
                }
            } catch (_) { /* raw text */ }
            term.write(ev.data);
        };

        ws.onclose = () => {
            connDot.className = 'disconnected';
            if (connText) connText.textContent = 'Disconnesso';
            term.write('\r\n\x1b[31m[Connessione chiusa]\x1b[0m');
            setTimeout(() => window.close(), 2000);
        };

        ws.onerror = () => {
            connDot.className = 'disconnected';
            if (connText) connText.textContent = 'Errore';
            term.write('\r\n\x1b[31m[Errore WebSocket]\x1b[0m');
        };
    }

    /* ── Modal submit handler ────────────────────────────────────── */
    function handleSubmit() {
        const username = userInput.value.trim();
        const password = passInput.value;
        const port = parseInt(portInput.value, 10) || 22;
        if (!username) { userInput.focus(); return; }
        modal.style.display = 'none';
        modal.style.visibility = 'hidden';
        connect(username, password, port);
    }

    submitBtn.addEventListener('click', handleSubmit);
    [userInput, passInput, portInput].forEach(el => {
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSubmit(); });
    });

    setTimeout(() => userInput && userInput.focus(), 100);
})();
