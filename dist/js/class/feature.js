class Feature {
    /**
     * @param {string} pageName Name of the page this feature is for.
     */
    constructor(pageName) {
        if (page.features.hasOwnProperty(pageName)) {
            throw new Error(`Feature "${pageName}" already exists.`);
        }
        page.features[pageName] = this;
    }

    preMount() {
        this.loadBreadcrumb();
        this.onMount();
    }
    preUnmount() {
        this.onUnmount();
    }

    loadBreadcrumb() {
        const breadcrumb = document.getElementById('breadcrumb');
        const breadcrumbA = breadcrumb?.getElementsByTagName('a');

        if (!breadcrumbA) return;
        const links = Array.from(breadcrumbA);
        links.forEach(element => {
            const dataPage = element.getAttribute('data-page');
            const dataCategory = element.getAttribute('data-category') || null;
            if (!dataPage) return;
            element.addEventListener('click', () => {
                page.Load(dataPage, dataCategory);
            });
        });
    }

    /**
     * Called when the page is mounted.
     */
    onMount() {}

    /**
     * Called just before the page is unmounted.
     */
    async onUnmount() {}
}