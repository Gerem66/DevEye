class Feature {
    /**
     * @param {string} pageName Name of the page this feature is for.
     */
    constructor(pageName) {
        if (!page.features.hasOwnProperty(pageName)) {
            page.features[pageName] = this;
        }
    }

    onMount() {
    }
    async onUnmount() {
    }
}