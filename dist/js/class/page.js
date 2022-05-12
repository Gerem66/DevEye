/**
 * @typedef {'user'} Pages
 */

 class Page {
    constructor() {
        /** @type {HTMLElement} */
        this.content;

        this.loading = false;
        this.features = {};
        this.lastFeatureName = null;
    }

    Init() {
        this.content = document.getElementById('main-content');

        /** @type {NodeListOf<HTMLElement>} */
        this.navbarItems = document.getElementsByName('sidebar-item');
        this.navbarItems.forEach(item => {
            const element = Array.from(item.getElementsByTagName('a'));
            if (element.length <= 0) {
                return;
            }
            element[0].onclick = async () => {
                this.NB_ClearActiveItems();
                const success = await this.Load(item.getAttribute('data-page'));
                if (success) this.NB_SetActiveItem(item);
            };
        });

        /** @type {NodeListOf<HTMLElement>} */
        this.navbarGroups = document.getElementsByName('sidebar-group');
        this.navbarGroups.forEach(group => {
            const element = Array.from(group.getElementsByTagName('a'));
            if (element.length <= 0) {
                return;
            }
            element[0].onclick = () => {
                group.classList.toggle('active');

                const ulGroup = Array.from(group.getElementsByTagName('ul'));
                if (ulGroup.length <= 0) {
                    return;
                }

                // Expand/collapse group if exists
                if (group.classList.contains('active')) {
                    const subItems = Array.from(group.getElementsByTagName('li'));
                    const height = subItems.map(item => item.offsetHeight).reduce((a, b) => a + b, 0);
                    ulGroup[0].style.height = height + 'px';
                } else {
                    ulGroup[0].style.height = '0px';
                }
            };
        });
    }

    /** @param {Boolean} isLoading */
    SetLoading(isLoading) {
        if (this.content === null) {
            console.warn('Page.SetLoading: content is null');
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
     * @returns {Promise<Boolean>}
     */
    async Load(page, data = null) {
        if (this.loading) return false;
        if (this.content === null) {
            console.warn('Page.Load: content is null');
            return false;
        }

        await this.features[this.lastFeatureName]?.onUnmount();
        this.lastFeatureName = null;

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
            this.features[page]?.onMount();
            this.lastFeatureName = page;
        }
        this.SetLoading(false);
        return true;
    }

    /** @param {HTMLElement} item */
    NB_SetActiveItem(item) {
        this.NB_ClearActiveItems();
        if (!item.classList.contains('active')) {
            item.classList.add('active');
        }
    }
    NB_ClearActiveItems() {
        this.navbarItems.forEach(item => {
            if (item.classList.contains('active')) {
                item.classList.remove('active');
            }
        });
    }
}