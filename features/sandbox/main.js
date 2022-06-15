class Sandbox extends Feature {
    constructor() {
        super('sandbox');
    }

    onMount(category) {
        this.category = category;
        this.loading = false;

        this.input = document.getElementById('input-php-sandbox');
        this.input.value = '$var = "Hello World";\nreturn $var;';
        this.input.oninput = () => this.input.rows = Math.max(5, this.input.value.split('\n').length);
        this.input.oninput();
        this.button = document.getElementById('btn-php-sandbox');
        this.button.onclick = () => this.sendPHP();
        this.output = document.getElementById('output-php-sandbox');

        this.savedText = document.getElementById('header-text');
        this.savedText.style.opacity = 0;
    }

    /**
     * Show message (success or error) at corner of the table
     * @param {Boolean} success
     */
    showSavedText(success = true) {
        let content = "<p>Code exécuté</p><img src='./assets/icons/success.svg' alt='Success icon'></img>";
        if (!success) {
            content = "<p>Une erreur est survenue</p><img src='./assets/icons/error.svg' alt='Error icon'></img>";
        }
        this.savedText.innerHTML = content;
        this.savedText.style.opacity = 1;
        this.savedTextTimeout && clearTimeout(this.savedTextTimeout);
        this.savedTextTimeout = setTimeout(() => {
            this.savedText.style.opacity = 0;
        }, 2 * 1000);
    }

    async sendPHP() {
        if (this.loading) {
            return;
        }

        this.loading = true;
        this.output.textContent = 'Chargement...';
        const data = { code: this.input.value };
        const response = await this.CallAction('php', data);

        if (response === null) {
            this.loading = false;
            this.output.textContent = 'Erreur de connexion';
            return;
        }

        this.loading = false;
        this.showSavedText(response['status'] === 'ok');
        this.output.textContent = JSON.stringify(response['result']);
    }
}

new Sandbox();