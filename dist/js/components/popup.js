class Popup {
    /**
     * @param {string} id
     */
    constructor(id) {
        this.id = id;

        /** @type {HTMLDivElement} */
        this.popup = document.getElementById(id);

        /** @type {Array<HTMLInputElement>} */
        this.inputs = Array.from(this.popup.getElementsByTagName('input'));

        this.inputsEvents = Input.LoadAll(this.popup);

        this.callback = () => {};
        this.SetCancelable(true);
    }

    /**
     * Can close popup by clicking on background (default: true)
     * @param {Boolean} cancelable
     */
    SetCancelable(cancelable) {
        const event = (ev) => cancelable && ev.target === this.popup && this.Close();
        this.popup.onclick = event;
    }

    /**
     * @param {(name: String) => void} callback 
     */
    AddButtonClickListener(callback) {
        this.callback = callback;

        let buttons = Array.from(this.popup.getElementsByClassName('btn'));
        buttons = buttons.filter(btn => btn.getAttribute('name') !== 'btn-toggle-pwd');
        buttons.forEach(button => button.onclick = () => this.callback(button.getAttribute('name')));
    }

    Open() {
        this.popup.classList.add('active');
    }
    Close(clearInputs = false) {
        this.popup.classList.remove('active');
        setTimeout(() => {
            if (clearInputs) {
                this.inputs.forEach(input => input.value = '');
            }
            this.inputsEvents.forEach(input => input.SetVisible(false));
        }, 200);
    }
}