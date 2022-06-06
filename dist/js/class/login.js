class Login {
    constructor() {
        this.connecting = false;
        this.loginContent = document.getElementById('login-content');

        // Login defs
        this.loginForm = document.getElementById('login-form');
        this.tbUsername = document.getElementById('tb-username');
        this.tbPassword = document.getElementById('tb-password');
        this.btConnect = document.getElementById('bt-connect');

        // Connect on enter
        const isEnter = (e) => e.key === 'Enter' && this.connect();
        this.loginForm.onkeydown = (e) => isEnter(e) || true;
        this.btConnect.onclick = this.connect.bind(this);

        // Loading defs
        this.loadingDiv = document.getElementById('loading');
        this.loadingText = document.getElementById('loading-text');
        this.loadingValue = document.getElementById('loading-value');
        this.loadingBar = document.getElementById('loading-bar');
    }

    /**
     * @param {number} value Set -1 to hide bar, [0, 100] to show
     * @param {string} text
     */
    loadingSetState(value, text = '') {
        this.loadingText.textContent = text;
        this.loadingValue.textContent = Math.max(0, value) + ' %';
        this.loadingBar.style.width = Math.max(0, value) + '%';
        this.loadingDiv.classList.toggle('form-hide', value === -1);
    };

    async connect() {
        if (this.connecting) {
            return;
        }

        this.tbUsername.classList.remove('error');
        this.tbPassword.classList.remove('error');
        const username = this.tbUsername.value;
        const password = this.tbPassword.value;

        if (username.length === 0) {
            this.tbUsername.classList.add('error');
        }
        if (password.length === 0) {
            this.tbPassword.classList.add('error');
        }
        if (username.length === 0 || password.length === 0) {
            return;
        }

        this.connecting = true;
        this.btConnect.disabled = true;
        this.tbUsername.disabled = true;
        this.tbPassword.disabled = true;

        this.loadingSetState(20, 'Vérification des identifiants...');
        const state = await deveye.server.UserConnection(username, password);

        if (state === 'ok') {
            await deveye.MountHome();
        } else {
            this.tbUsername.classList.add('error');
            this.tbPassword.classList.add('error');

            this.btConnect.disabled = false;
            this.tbUsername.disabled = false;
            this.tbPassword.disabled = false;
            this.connecting = false;
            this.loadingSetState(-1);
        }
    }
}