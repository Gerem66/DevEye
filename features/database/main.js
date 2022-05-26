class Database extends Feature {
    constructor() {
        super('database');
    }

    onMount(category) {
        this.category = category;

        const cards = Array.from(document.getElementsByClassName('card'));

        cards.forEach(card => {
            const cardName = card.getAttribute('data-title');
            const table = new DBTable(card, cardName, 'database');
            table.AddFeature('cellchange');
            table.AddFeature('navigation');
            table.AddFeature('rowadd');
            table.AddFeature('rowremove');
        });
    }
}

new Database();