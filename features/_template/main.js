class Newfeature extends Feature {
    constructor() {
        super('newfeature');
    }

    onMount(category) {
        this.category = category;
    }
    async onUnmount() {
    }
}

new Newfeature();