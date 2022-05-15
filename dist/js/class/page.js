/**
 * @typedef {'database'|'user'|'logs'} Pages
 */

 class Page {
    constructor() {
        /** @type {HTMLElement} */
        this.content;

        /** @type {Array<Feature>} */
        this.features = {};

        this.sidebar = new Sidebar(this);
        this.loading = false;
        this.currentFeatureName = null;
    }

    Init() {
        this.sidebar.Init();
        this.content = document.getElementById('main-content');
    }

    /** @param {Boolean} isLoading */
    SetLoading(isLoading) {
        if (this.content === null) {
            throw new Error('Page.SetLoading: content is null');
        }
        this.loading = isLoading;
        if (isLoading) {
            this.content.classList.add('loading');
        } else {
            this.content.classList.remove('loading');
        }
    }

    /**
     * @param {Pages} page
     * @param {String} category
     * @param {Object} [data=null]
     * @returns {Promise<Boolean>}
     */
    async Load(page, category, data = null) {
        if (this.loading) return false;
        if (this.content === null) {
            throw new Error('Page.Load: content is null');
        }

        this.sidebar.ClearActiveItems();
        await this.features[this.currentFeatureName]?.preUnmount();
        this.currentFeatureName = null;

        this.SetLoading(true);

        let params = null;
        if (data !== null) {
            let fd = new FormData();
            for (let i in data) {
                fd.append(i, data[i]);
            }
            params = { method: 'POST', body: fd };
        }

        const response = await fetch('./' + page, params)
        const content = await response.text();

        if (content === 'disconnect') {
            window.location.reload();
            return false;
        }
        this.content.innerHTML = content;

        if (this.features.hasOwnProperty(page)) {
            this.features[page]?.preMount(category);
            this.currentFeatureName = page;
        }

        this.SetLoading(false);
        this.sidebar.SetActiveItem(page, category);
        return true;
    }
}