class Database extends Feature {
    constructor() {
        super('database');
    }

    onMount() {
        console.log('Database mounted');
    }

    async onUnmount() {
        console.log('Database unmounted');
    }
}

new Database();