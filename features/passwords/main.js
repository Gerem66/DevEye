class Passwords extends Feature {
    constructor() {
        super('passwords');
    }

    onMount(category) {
        this.category = category;
    }
    async onUnmount() {
    }
}

new Passwords();