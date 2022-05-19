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

        const buttons = Array.from(this.popup.getElementsByClassName('btn'));
        buttons.forEach(button => button.onclick = () => this.callback(button.getAttribute('name')));
    }

    Open() {
        this.popup.classList.add('active');
    }
    Close() {
        this.popup.classList.remove('active');
    }
}