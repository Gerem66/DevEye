/**
 * @typedef {Object.<string, HTMLButtonElement} PopupButtons
 * 
 * @typedef {Object} PopupInputs
 * @property {Object.<string, HTMLInputElement>} inputs
 * @property {Object.<string, HTMLSelectElement>} selects
 * @property {Object.<string, HTMLTextAreaElement>} textareas
 * 
 * @typedef {Object} PopupResults
 * @property {Object.<string, string>} inputs
 * @property {Object.<string, string>} selects
 * @property {Object.<string, string>} textareas
 * 
 * @typedef {Object} PopupOutputs
 * @property {Object.<string, HTMLParagraphElement>} p
 * 
 * @typedef {Object} PopupSettings
 * @property {String?} [title=null] The title of the popup, not edit if null
 * @property {Boolean} [cancelable=true] True if popup can be closed by clicking on background or escape key
 * @property {'close'|'blur'|'nothing'} [atEnd='close'] Behaviour of the popup after buttons are clicked
 * 
 * @callback PopupAfterStartCallback
 * @param {PopupInputs} inputs Keys are buttons name and values are them
 * @param {PopupOutputs} outputs Keys are buttons name and values are them
 * @returns {void}
 */

const DEFAULT_SETTINGS = { title: null, cancelable: true, atEnd: 'close' };

class Popup {
    /**
     * @param {string} id
     */
    constructor(id) {
        /** @type {HTMLDivElement} */
        this.popup = document.getElementById(id) || null;
        if (this.popup === null) {
            throw new Error(`Popup ${id} not found`);
        }

        this.opened = false;
        this.card = this.popup.firstElementChild;
    }

    /**
     * Open popup and define all inputs, outputs, buttons and events
     * @param {PopupSettings} [settings=DEFAULT_SETTINGS]
     * @param {PopupAfterStartCallback} callback Called after start of popup, to initialize inputs and outputs
     * @returns {Promise<[ String?, PopupResults ]>|null} [ closeType (null = click on background, otherwise button name), inputs ] or null if popup is already opened
     */
    async Open(settings = DEFAULT_SETTINGS, callback = () => {}) {
        if (this.opened) return null;
        this.opened = true;
        settings = Object.assign({}, DEFAULT_SETTINGS, settings);

        if (settings.title !== null && this.card.classList.contains('card')) {
            this.card.setAttribute('data-title', settings.title);
        }
        this.popup.classList.add('active');
        const inputs = this.getInputs();
        const outputs = this.getOutputs();
        const buttons = this.getButtons(inputs);
        callback(inputs, outputs);

        const closeType = await new Promise(resolve => {
            if (settings.cancelable) {
                this.popup.onclick = (ev) => {
                    if (ev.target === this.popup) {
                        resolve('background');
                    }
                };
                this.popup.onkeydown = (ev) => {
                    if (ev.key === 'Escape') {
                        resolve('escape');
                    }
                }
            }

            for (let btn in buttons) {
                buttons[btn].onclick = () => {
                    resolve(btn);
                };
            }
        });

        const results = this.getResults(inputs)
        if (settings.atEnd === 'close') {
            this.Close();
        } else if (settings.atEnd === 'blur') {
            this.card.classList.add('blur');
            this.popup.onclick = null; // Disable background click
            this.popup.onkeydown = null; // Disable escape key
        }
        return [ closeType, results ];
    }

    async Close() {
        this.popup.classList.remove('active');
        this.card.classList.remove('blur');
        await Sleep(200); // wait for animation

        // Reset inputs
        const inputs = this.getInputs();
        Object.values(inputs.inputs).forEach(input => input.value = '');
        Object.values(inputs.selects).forEach(select => select.selectedIndex = 0);
        Object.values(inputs.textareas).forEach(textarea => textarea.value = '');

        // Reset events
        const buttons = Array.from(this.popup.getElementsByTagName('button'));
        Object.values(buttons).forEach(btn => btn.onclick = null);

        // Remove background event
        this.popup.onclick = null;

        this.opened = false;
    }

    /** @returns {PopupOutputs} */
    getOutputs() {
        let outputs = { p: {} };
        let p = Array.from(this.popup.getElementsByTagName('p'));
        p.filter(p => p.getAttribute('name') !== null);
        p.forEach(p => outputs['p'][p.getAttribute('name')] = p);
        return outputs;
    }

    /** @returns {PopupInputs} */
    getInputs() {
        const parent = this.popup;
        const allInputs = { inputs: {}, selects: {}, textareas: {} };
        const inputs = Array.from(parent.getElementsByTagName('input'));
        const selects = Array.from(parent.getElementsByTagName('select'));
        const textareas = Array.from(parent.getElementsByTagName('textarea'));
        inputs.forEach(input => allInputs['inputs'][input.name] = input);
        selects.forEach(select => allInputs['selects'][select.name] = select);
        textareas.forEach(textarea => allInputs['textareas'][textarea.name] = textarea);
        return allInputs;
    }

    /**
     * @param {PopupInputs} inputs
     * @returns {PopupResults}
     */
    getResults(inputs) {
        let results = {};
        Object.keys(inputs).forEach(key => {
            if (key === 'inputs' || key === 'selects' || key === 'textareas') {
                results[key] = {};
                Object.keys(inputs[key]).forEach(key2 => {
                    results[key][key2] = inputs[key][key2].value;
                });
            }
        });
        return results;
    }

    /**
     * @param {PopupInputs} inputs
     * @returns {PopupButtons}
     */
    getButtons(inputs) {
        const btns = Array.from(this.popup.getElementsByTagName('button'));
        let buttons = {};
        btns.forEach(btn => {
            if (btn.name === 'toggle') {
                const inputName = btn.getAttribute('data-input');
                if (inputName === null) return;
                const input = inputs.inputs[inputName];
                const eye = btn.getElementsByTagName('i')[0];

                btn.onclick = () => {
                    input.type = input.type === 'password' ? 'text' : 'password';
                    eye.classList.toggle('icon-eye-open');
                    eye.classList.toggle('icon-eye-close');
                }
                if (input.type !== 'password') {
                    btn.click();
                }
            } else {
                buttons[btn.name] = btn;
            }
        });
        return buttons;
    }
}