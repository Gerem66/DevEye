class Input {
    /** @param {HTMLElement} group */
    constructor(group) {
        this.input = group.getElementsByTagName('input')[0];
        this.button = group.getElementsByTagName('button')[0];
        this.button.onclick = () => this.SetVisible();
        this.buttonIcon = this.button.firstElementChild;
        this.visible = this.button.classList.contains('icon-eye-open');

    }

    /** @param {Boolean} visible */
    SetVisible(visible = !this.visible) {
        this.visible = visible;
        this.input.type = visible ? 'text' : 'password';
        this.buttonIcon.classList.toggle('icon-eye-open', visible);
        this.buttonIcon.classList.toggle('icon-eye-close', !visible);
    }

    /**
     * @param {HTMLElement} parent
     * @returns {Array<Input>}
     */
    static LoadAll(parent = document) {
        let inputs = [];

        const groups = Array.from(parent.getElementsByClassName('form-group'));
        groups.forEach(group => {
            if (group.children.length !== 2) return;
            const input = group.children[0];
            const button = group.children[1];
            if (input.tagName !== 'INPUT' || button.tagName !== 'BUTTON') return;
            inputs.push(new Input(group));
        });

        return inputs;
    }
}