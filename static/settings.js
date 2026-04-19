/* ─── settings.js ───────────────────────────────────────────────── */
(async function () {
    'use strict';

    const subnetInput = document.getElementById('set-subnet');
    const userInput   = document.getElementById('set-user');
    const passInput   = document.getElementById('set-pass');
    const portInput   = document.getElementById('set-port');
    const saveBtn     = document.getElementById('save-btn');

    /* ── Load current settings ─────────────────────────────────── */
    try {
        const res = await fetch('/api/settings');
        if (res.ok) {
            const data = await res.json();
            subnetInput.value = data.subnet       || '192.168.1.0/24';
            userInput.value   = data.ssh_user     || 'root';
            passInput.value   = data.ssh_password || '';
            portInput.value   = data.ssh_port     || 22;
        }
    } catch {
        /* server unreachable — leave placeholders */
    }

    /* ── Save ──────────────────────────────────────────────────── */
    saveBtn.addEventListener('click', async () => {
        const orig = saveBtn.textContent;
        saveBtn.textContent = 'Salvataggio…';
        saveBtn.disabled = true;

        const payload = {
            subnet:       subnetInput.value.trim(),
            ssh_user:     userInput.value.trim(),
            ssh_password: passInput.value,
            ssh_port:     parseInt(portInput.value, 10) || 22,
        };

        try {
            const res = await fetch('/api/settings', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(payload),
            });
            if (res.ok) {
                saveBtn.textContent = 'Salvato ✓';
                setTimeout(() => { window.location.href = '/'; }, 700);
            } else {
                throw new Error();
            }
        } catch {
            saveBtn.textContent = 'Errore';
            setTimeout(() => { saveBtn.textContent = orig; saveBtn.disabled = false; }, 2000);
        }
    });

    /* ── Enter to save ─────────────────────────────────────────── */
    [subnetInput, userInput, passInput, portInput].forEach(el =>
        el.addEventListener('keydown', e => { if (e.key === 'Enter') saveBtn.click(); })
    );
})();
