class Logs extends Feature {
    constructor() {
        super('logs');
    }

    onMount(category) {
        this.category = category;
        this.btnPrev = document.getElementById('btn-prev');
        this.btnNext = document.getElementById('btn-next');
        this.btnLast = document.getElementById('btn-last');
        this.btnPrev.onclick = () => this.requestLogs('prev');
        this.btnNext.onclick = () => this.requestLogs('next');
        this.btnLast.onclick = () => this.requestLogs('last');
    }
    async onUnmount() {
    }

    /**
     * Ask the server for the logs & show them
     * @param {'prev'|'next'|'last'} type 
     */
    async requestLogs(type) {
        page.Load('logs', this.category, { type });
        return;
        const data = { type };
        const response = await Request_Async('./logs', data);
        if (response.status !== 200 || response.content['status'] !== 'ok') {
            throw new Error(`Error while requesting logs: ${response.status} - ${response.content['error']}`);
        }
        console.log(response);
    }
}

new Logs();