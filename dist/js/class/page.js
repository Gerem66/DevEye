/**
 * @typedef {'database'|'user'|'logs'} Pages
 */

 class Page {
    constructor() {
        /** @type {HTMLElement} */
        this.topbar;

        /** @type {HTMLElement} */
        this.content;

        /** @type {Array<Feature>} */
        this.features = {};

        this.sidebar = new Sidebar(this);
        this.loading = false;
        this.currentFeatureName = null;
        this.defaultPage = 'user';
    }

    Init() {
        this.sidebar.Init();
        this.topbar = document.getElementById('topbar');
        this.content = document.getElementById('main-content');
        this.content.onclick = () => this.sidebar.HideSidebarOnSmallScreen();
        this.Load(this.defaultPage);
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

        this.sidebar.HideSidebarOnSmallScreen();
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

        if (response.status !== 200) {
            this.SetLoading(false);
            if (response.status !== 404) {
                throw new Error(`Page.Load: loading failed (${response.status} ${response.statusText})`);
            }
        }

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