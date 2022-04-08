/**
 * @typedef {'user'} Pages
 */

class Page {
    constructor() {
        /** @type {HTMLElement} */
        this.content;

        /** @type {Navbar} */
        this.navbar;

        this.loading = false;
    }

    Init() {
        this.navbar = new Navbar(this);
        this.navbar.setEventsSidebarItems();
        this.content = document.getElementById('main-content');
    }

    /** @param {Boolean} isLoading */
    SetLoading(isLoading) {
        this.loading = isLoading;
        if (isLoading) {
            this.content.classList.add('loading');
        } else {
            this.content.classList.remove('loading');
        }
    }

    /**
     * @param {Pages} page
     * @returns {Promise<string>}
     */
    async Load(page, data = null) {
        if (this.loading) return;

        this.SetLoading(true);
        this.navbar.ClearActiveItems();

        let params = null;
        if (data !== null) {
            let fd = new FormData();
            for (let i in data) {
                fd.append(i, data[i]);
            }
            params = { method: 'POST', body: fd };
        }

        const response = await fetch('./' + page, params)
        const content = response.text();

        if (content === 'disconnect') {
            window.location.reload();
            return false;
        }
        this.content.innerHTML = await content;

        this.SetLoading(false);
        this.navbar.SetActiveItem(page)
    }
}