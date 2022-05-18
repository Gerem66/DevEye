class Logs extends Feature {
    constructor() {
        super('logs');
    }

    onMount(category) {
        this.category = category;

        const tableElement = document.getElementsByClassName('card')[0];
        const table = new DBTable(tableElement, 'Logs', 'logs');
        table.AddEventListener('oncellchange', this.onCellChange);
        table.AddEventListener('onrowadd', this.onRowAdd);
        table.AddEventListener('onrowremove', this.onRowRemove);
        table.AddEventListener('onnavigation', this.onNavigation);
    }
    async onUnmount() {
    }

    /** @type {DBTableEvents['oncellchange']} */
    async onCellChange(table, ID, column, value) {
        const data = { type: 'cellchange', table, ID, column, value };
        const response = await Request_Async('./logs', data);
        if (response.status !== 200 || response.content?.status !== 'ok') {
            return false;
        }
        return true;
    }

    /** @type {DBTableEvents['onrowadd']} */
    async onRowAdd(table) {
        const data = { type: 'rowadd', table };
        const response = await Request_Async('./logs', data);
        if (response.status !== 200 || response.content?.status !== 'ok') {
            return null;
        }
        return response.content?.content || null;
    }

    /** @type {DBTableEvents['onrowremove']} */
    async onRowRemove(table, ID, page) {
        const data = { type: 'rowremove', table, ID, page };
        const response = await Request_Async('./logs', data);
        if (response.status !== 200 || response.content?.status !== 'ok') {
            return null;
        }
        return response.content?.content || null;
    }

    /** @type {DBTableEvents['onnavigation']} */
    async onNavigation(table, page) {
        const data = { type: 'navigation', table, page };
        const response = await Request_Async('./logs', data);
        if (response.status !== 200 || response.content?.status !== 'ok') {
            return null;
        }
        const newPage = response.content.newPage || 1;
        const maxPage = response.content.maxPage || 1;
        const content = response.content.content || '';
        return [ newPage, maxPage, content ];
    }
}

new Logs();