(function () {
    const $ = (id) => document.getElementById(id);
    const errorBox = $('loginError');

    async function post(url, body) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'betha' },
            body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
        return data;
    }

    function show(id) {
        ['loading', 'loginForm', 'setupForm', 'setupRemote'].forEach((x) => $(x).classList.toggle('d-none', x !== id));
        const input = document.querySelector(`#${id} input`);
        if (input) input.focus();
    }

    async function init() {
        try {
            const res = await fetch('/api/auth/status', { headers: { 'X-Requested-With': 'betha' } });
            const st = await res.json();
            if (st.authenticated) return location.replace('/');
            if (st.setupRequired) return show(st.canSetup ? 'setupForm' : 'setupRemote');
            show('loginForm');
        } catch (e) {
            errorBox.textContent = 'No se pudo contactar con el servidor.';
        }
    }

    $('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        errorBox.textContent = '';
        const btn = e.submitter;
        btn.disabled = true;
        try {
            await post('/api/auth/login', { password: $('loginPassword').value });
            location.replace('/');
        } catch (err) {
            errorBox.textContent = err.message;
            $('loginPassword').select();
        } finally {
            btn.disabled = false;
        }
    });

    $('setupForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        errorBox.textContent = '';
        if ($('setupPassword').value !== $('setupConfirm').value) {
            errorBox.textContent = 'Las contraseñas no coinciden.';
            return;
        }
        try {
            await post('/api/auth/setup', { password: $('setupPassword').value });
            location.replace('/');
        } catch (err) {
            errorBox.textContent = err.message;
        }
    });

    init();
})();
