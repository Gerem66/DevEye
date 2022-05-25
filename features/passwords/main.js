class Passwords extends Feature {
    constructor() {
        super('passwords');
    }

    onMount(category) {
        this.category = category;
        this.loading = false;
        this.selectedCell = null;

        this.inputCategory = document.getElementById('input-category');
        this.inputService = document.getElementById('input-service');
        this.inputUsername = document.getElementById('input-username');
        this.inputPassword = document.getElementById('input-password');
        this.inputStatus = document.getElementById('input-status');
        this.inputCategoryOld = document.getElementById('input-category-old');
        this.inputCategoryNew = document.getElementById('input-category-new');

        // Popups
        this.popupMessage = new Popup('popup-message');
        this.popupMessage.AddButtonClickListener(() => this.popupMessage.Close());

        const popupAdd = new Popup('popup-password');
        popupAdd.AddButtonClickListener(name => {
            if (name === 'btn-save') this.AddPassword();
            else popupAdd.Close();
        });

        const popupVerify = new Popup('popup-verify');
        popupVerify.AddButtonClickListener(name => {
            if (name === 'btn-unlock') {
                const password = popupVerify.inputs[0].value;
                popupVerify.Close();
                this.ShowPassword(this.selectedCell, password);
            } else {
                popupVerify.Close();
            }
        });

        // Show passwords
        const eyes = document.getElementsByName('icon-show-password');
        eyes.forEach(eye => {
            eye.onclick = () => {
                this.selectedCell = eye.parentElement;
                popupVerify.Open();
            }
        });

        // Add passwords
        const buttonsAdd = document.getElementsByName('btn-add-password');
        buttonsAdd.forEach(button => {
            button.onclick = () => {
                this.inputCategory.value = button.getAttribute('data-title') || '';
                popupAdd.Open();
            }
        });

        // Search passwords
        const inputSearch = document.getElementById('input-search');
        inputSearch.oninput = () => this.Search(inputSearch.value.toLowerCase());

        // Edit category
        const popupCategory = new Popup('popup-edit-category');
        popupCategory.AddButtonClickListener(name => {
            if (name === 'btn-edit') this.EditCategory();
            else if (name === 'btn-back') popupCategory.Close();
        });
        const buttonsCategory = document.getElementsByName('btn-edit-category');
        buttonsCategory.forEach(button => {
            button.onclick = () => {
                this.inputCategoryOld.value = button.getAttribute('data-title') || '';
                popupCategory.Open();
            }
        });
    }

    Search(search) {
        // Show / hide rows content
        const lines = Array.from(document.getElementsByTagName('tr'));
        lines.forEach(line => {
            if (line.getAttribute('data-id') === null) {
                return;
            }

            const title = line.firstElementChild.textContent.toLowerCase();
            line.style.display = title.includes(search) ? 'table-row' : 'none';
        });

        // Show / hide tables
        const tables = Array.from(document.getElementsByTagName('table'));
        tables.forEach(table => {
            const card = table.parentElement;
            const title = card.getAttribute('data-title');
            if (title === null) return;

            const tbody = table.getElementsByTagName('tbody')[0];
            const lines = Array.from(tbody.getElementsByTagName('tr'));
            const linesOn = lines.filter(line => line.style.display !== 'none');
            card.style.display = linesOn.length === 0 ? 'none' : 'block';
        });
    }

    async EditCategory() {
        const data = {
            action: 'categoryEdit',
            old: this.inputCategoryOld.value,
            new: this.inputCategoryNew.value
        };
        const response = await Request_Async('./passwords', data);
        const success = response.status === 200 && response.content['status'] === 'ok';
        if (!success) {
            const popupMessageP = this.popupMessage.popup.getElementsByTagName('p')[0];
            popupMessageP.textContent = 'Une erreur est survenue lors de la modification de la catégorie.';
            this.popupMessage.Open();
            return;
        }
        page.Load('passwords');
    }

    /**
     * @param {HTMLElement} cell
     * @param {String} password
     */
    async ShowPassword(cell, password) {
        if (this.loading) {
            return;
        }

        const id = parseInt(cell.parentElement.getAttribute('data-id')) || 0;
        const icon = cell.getElementsByTagName('i')[0];
        const text = cell.getElementsByTagName('p')[0];

        this.loading = true;
        const popupMessageP = this.popupMessage.popup.getElementsByTagName('p')[0];

        const data = { action: 'show', id, password };
        const response = await Request_Async('./passwords', data);

        if (response.status === 200) {
            if (response.content['status'] === 'ok') {
                const initPasswordContent = text.textContent;
                text.textContent = response.content['content'];
                icon.style.display = 'none';

                this.timeout && clearTimeout(this.timeout);
                this.timeout = setTimeout(() => {
                    text.textContent = initPasswordContent;
                    icon.style.display = 'inline-block';
                }, 10 * 1000);
            } else if (response.content['status'] === 'wrong') {
                popupMessageP.textContent = 'Le mot de passe est incorrect.';
                this.popupMessage.Open();
            }
        } else {
            popupMessageP.textContent = 'Une erreur est survenue';
            this.popupMessage.Open();
        }

        this.loading = false;
    }
    async AddPassword() {
        const data = {
            action: 'add',
            category: this.inputCategory.value.trim(),
            service: this.inputService.value,
            username: this.inputUsername.value,
            password: this.inputPassword.value,
            status: this.inputStatus.value
        };
        const response = await Request_Async('./passwords', data);
        const success = response.status === 200 && response.content['status'] === 'ok';

        if (success) {
            page.Load('passwords');
        }
    }
}

new Passwords();