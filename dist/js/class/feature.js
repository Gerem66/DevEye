class Feature {
    /**
     * @param {string} pageName Name of the page this feature is for.
     */
    constructor(pageName) {
        if (deveye.features.hasOwnProperty(pageName)) {
            throw new Error(`Feature "${pageName}" already exists.`);
        }
        deveye.features[pageName] = this;
    }

    preMount(category) {
        this.loadBreadcrumb(category);
        this.onMount(category);
    }
    async preUnmount() {
        await this.onUnmount();
    }

    loadBreadcrumb(category) {
        const breadcrumb = document.getElementById('breadcrumb');
        const breadcrumbA = breadcrumb?.getElementsByTagName('a');

        if (!breadcrumbA) return;
        const links = Array.from(breadcrumbA);
        links.forEach(element => {
            const dataPage = element.getAttribute('data-page');
            if (!dataPage) return;
            element.addEventListener('click', () => {
                deveye.Load(dataPage, category);
            });
        });
    }

    /**
     * Called when the page is mounted.
     * @param {string} category
     */
    onMount(category) {}

    /**
     * Called just before the page is unmounted.
     */
    async onUnmount() {}
}