class Sandbox extends Feature {
    constructor() {
        super('sandbox');
    }

    onMount(category) {
        this.category = category;

        this.input = document.getElementById('input-php-sandbox');
        this.input.value = '$var = "Hello World";\nreturn $var;';
        this.input.oninput = () => this.input.rows = Math.max(5, this.input.value.split('\n').length);
        this.input.oninput();
        this.button = document.getElementById('btn-php-sandbox');
        this.button.onclick = () => this.sendPHP();
        this.output = document.getElementById('output-php-sandbox');
    }
    async onUnmount() {
    }

    async sendPHP() {
        const data = { code: this.input.value };
        const response = await Request_Async('./sandbox', data);
        const result = response.content?.result;
        this.output.textContent = JSON.stringify(result);
    }
}

new Sandbox();