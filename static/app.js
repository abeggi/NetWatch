/* ─── app.js – Network Scanner SPA ─────────────────────────────── */

(function () {
    'use strict';

    const hostGrid     = document.getElementById('host-grid');
    const statusDot    = document.getElementById('status-dot');
    const statusText   = document.getElementById('status-text');
    const hostCount    = document.getElementById('host-count');
    const emptyState   = document.getElementById('empty-state');
    const progressWrap = document.getElementById('progress-wrap');
    const progressBar  = document.getElementById('progress-bar');
    const scanBtn      = document.getElementById('scan-btn');
    const scanIcon     = document.getElementById('scan-icon');

    scanBtn.addEventListener('click', startScan);

    let scanWs        = null;
    let hosts         = [];
    let scanInProgress = false;

    /* ── Utility ───────────────────────────────────────────────────── */
    function ipToInt(ip) {
        return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
    }

    function insertionIndex(ip) {
        const val = ipToInt(ip);
        let lo = 0, hi = hosts.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (ipToInt(hosts[mid].ip) < val) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    /* ── Build a card ──────────────────────────────────────────────── */
    function buildCard(host) {
        const div = document.createElement('div');
        div.className = 'host-card';
        div.dataset.ip = host.ip;
        div.onclick = () => openTerminal(host.ip);

        const isResolved = host.hostname && host.hostname !== host.ip;
        div.innerHTML = `
          <div class="card-hostname ${isResolved ? 'resolved' : ''}">${host.hostname || host.ip}</div>
          <div class="card-ip">${host.ip}</div>
          <div class="card-ssh-label">SSH · 22</div>
          <span class="card-arrow">›</span>`;
        return div;
    }

    /* ── Insert host in IP order ───────────────────────────────────── */
    function insertHost(host) {
        const idx = insertionIndex(host.ip);
        if (hosts[idx] && hosts[idx].ip === host.ip) return;
        hosts.splice(idx, 0, host);
        emptyState.style.display = 'none';

        const card = buildCard(host);
        const cards = hostGrid.querySelectorAll('.host-card');
        if (idx >= cards.length) hostGrid.appendChild(card);
        else hostGrid.insertBefore(card, cards[idx]);

        hostCount.textContent = `${hosts.length} host${hosts.length !== 1 ? 's' : ''}`;
    }

    function clearTable() {
        hosts = [];
        hostGrid.innerHTML = '';
        hostCount.textContent = '';
        emptyState.style.display = 'flex';
    }

    function setStatus(state, text) {
        statusDot.className = 'status-dot' + (state ? ' ' + state : '');
        statusText.textContent = text;
    }

    /* ── Cache ─────────────────────────────────────────────────────── */
    async function loadCache() {
        try {
            const res = await fetch('/api/cache');
            if (!res.ok) return;
            const data = await res.json();
            if (data && data.length > 0) {
                data.forEach(h => insertHost(h));
                setStatus('done', `Cache caricata — ${data.length} host dall'ultima scansione.`);
            } else {
                setStatus('', 'Nessun dato in cache — avvia una scansione.');
            }
        } catch {
            setStatus('', 'Server non raggiungibile.');
        }
    }

    /* ── Scan ──────────────────────────────────────────────────────── */
    function startScan() {
        if (scanInProgress) return;
        if (scanWs) { scanWs.close(); scanWs = null; }

        clearTable();
        scanInProgress = true;
        scanBtn.disabled = true;
        scanIcon.classList.add('scanning-icon');
        progressWrap.style.display = 'block';
        progressBar.style.width = '0%';
        setStatus('scanning', 'Scansione in corso…');

        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        scanWs = new WebSocket(`${proto}://${location.host}/ws/scan`);

        scanWs.onmessage = (ev) => {
            try {
                const msg = JSON.parse(ev.data);
                if (msg.type === 'host') {
                    insertHost(msg);
                } else if (msg.type === 'update_host') {
                    const card = hostGrid.querySelector(`.host-card[data-ip="${msg.ip}"]`);
                    if (card) {
                        const el = card.querySelector('.card-hostname');
                        if (el) { el.textContent = msg.hostname; el.classList.add('resolved'); }
                    }
                } else if (msg.type === 'progress') {
                    progressBar.style.width = Math.min(msg.percent, 99) + '%';
                } else if (msg.type === 'done') {
                    progressBar.style.width = '100%';
                    setTimeout(() => progressWrap.style.display = 'none', 800);
                    setStatus('done', `Scansione completata — ${hosts.length} host trovati.`);
                    scanInProgress = false;
                    scanBtn.disabled = false;
                    scanIcon.classList.remove('scanning-icon');
                } else if (msg.type === 'error') {
                    setStatus('error', `Errore: ${msg.message}`);
                    scanInProgress = false;
                    scanBtn.disabled = false;
                    scanIcon.classList.remove('scanning-icon');
                    progressWrap.style.display = 'none';
                }
            } catch { /* ignore */ }
        };

        scanWs.onerror = () => {
            setStatus('error', 'Errore WebSocket durante la scansione.');
            scanInProgress = false;
            scanBtn.disabled = false;
            scanIcon.classList.remove('scanning-icon');
            progressWrap.style.display = 'none';
        };

        scanWs.onclose = () => {
            if (scanInProgress) {
                setStatus('error', 'Connessione WebSocket chiusa inaspettatamente.');
                scanInProgress = false;
                scanBtn.disabled = false;
                scanIcon.classList.remove('scanning-icon');
                progressWrap.style.display = 'none';
            }
        };
    }

    /* ── Terminal ──────────────────────────────────────────────────── */
    function openTerminal(ip, port) {
        const p = port ? `&port=${encodeURIComponent(port)}` : '';
        window.open(`/static/terminal.html?host=${encodeURIComponent(ip)}${p}`, '_blank');
    }

    /* ── Quick Connect ─────────────────────────────────────────────── */
    const ipFirstThreeInput = document.getElementById('ip-first-three');
    const ipLastInput       = document.getElementById('ip-last-octet');
    const ipPortInput       = document.getElementById('qc-port');
    const quickConnectBtn   = document.getElementById('quick-connect-btn');

    function extractNetworkPrefix(subnet) {
        if (!subnet) return '192.168.1';
        const match = subnet.match(/^(\d+\.\d+\.\d+)\.\d+(?:\/\d+)?$/);
        if (match) return match[1];
        const parts = subnet.split('.');
        if (parts.length >= 3) return parts.slice(0, 3).join('.');
        return '192.168.1';
    }

    function updateQuickConnect(subnet) {
        ipFirstThreeInput.value = extractNetworkPrefix(subnet);
    }

    function handleQuickConnect() {
        const prefix  = ipFirstThreeInput.value.trim().replace(/\.$/, '');
        const lastNum = parseInt(ipLastInput.value.trim(), 10);
        const port    = parseInt(ipPortInput.value.trim(), 10) || 22;

        if (!ipLastInput.value.trim() || isNaN(lastNum) || lastNum < 1 || lastNum > 254) {
            ipLastInput.focus();
            ipLastInput.style.color = 'var(--danger)';
            setTimeout(() => ipLastInput.style.color = '', 700);
            return;
        }

        openTerminal(prefix + '.' + lastNum, port);
        ipLastInput.value = '';
    }

    quickConnectBtn.addEventListener('click', handleQuickConnect);
    [ipFirstThreeInput, ipLastInput, ipPortInput].forEach(el =>
        el.addEventListener('keydown', e => { if (e.key === 'Enter') handleQuickConnect(); })
    );

    ipLastInput.addEventListener('input', function () {
        this.value = this.value.replace(/[^0-9]/g, '').slice(0, 3);
    });
    ipPortInput.addEventListener('input', function () {
        this.value = this.value.replace(/[^0-9]/g, '').slice(0, 5);
    });

    /* ── Boot ──────────────────────────────────────────────────────── */
    async function boot() {
        loadCache();
        try {
            const res = await fetch('/api/settings');
            if (res.ok) {
                const data = await res.json();
                updateQuickConnect(data.subnet || '192.168.1.0/24');
            }
        } catch { /* use default */ }
    }

    boot();
})();
