class Logs extends Feature {
    constructor() {
        super('logs');
    }

    onMount(category) {
        this.category = category;

        const card = document.getElementsByClassName('card')[0];
        const table = new DBTable(card, 'Logs', 'logs');
        table.AddFeature('cellchange');
        table.AddFeature('navigation');
        table.AddFeature('rowadd');
        table.AddFeature('rowremove');
    }
}

new Logs();