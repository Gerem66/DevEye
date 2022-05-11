class Logs extends Feature {
    constructor() {
        super('logs');
    }

    onMount() {
        console.log('Logs mounted');
    }

    async onUnmount() {
        console.log('Logs unmounted');
    }
}

new Logs();