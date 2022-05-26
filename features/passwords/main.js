class Passwords extends Feature {
    constructor() {
        super('passwords');
    }

    onMount(category) {
        this.category = category;
        this.loading = false;

        // Popups
        this.popupAdd = new Popup('popup-password');
        this.popupMessage = new Popup('popup-message');
        this.popupVerify = new Popup('popup-verify');
        this.popupEditCategory = new Popup('popup-edit-category');

        // Show passwords
        const eyes = document.getElementsByName('icon-show-password');
        eyes.forEach(eye => eye.onclick = () => this.ShowPassword(eye.parentElement));

        // Search passwords
        const inputSearch = document.getElementById('input-search');
        inputSearch.oninput = () => this.Search(inputSearch.value.toLowerCase());

        // Add passwords
        const buttonsAdd = document.getElementsByName('btn-add-password');
        buttonsAdd.forEach(button => {
            button.onclick = () => {
                const title = button.getAttribute('data-title') || '';
                this.AddPassword(title);
            }
        });

        // Edit category
        const buttonsCategory = document.getElementsByName('btn-edit-category');
        buttonsCategory.forEach(button => {
            button.onclick = () => {
                const category = button.getAttribute('data-title') || null;
                category !== null && this.EditCategory(category);
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

    async EditCategory(category) {
        const [ closeType, results ] = await this.popupEditCategory.Open({ atEnd: 'blur' }, (inputs, outputs) => {
            inputs.inputs['input-category-old'].value = category;
        });
        if (closeType !== 'btn-edit') {
            this.popupEditCategory.Close();
            return;
        }

        const data = {
            action: 'categoryEdit',
            old: results.inputs['input-category-old'],
            new: results.inputs['input-category-new']
        };
        const response = await Request_Async('./passwords', data);
        const success = response.status === 200 && response.content['status'] === 'ok';
        if (!success) {
            this.popupMessage.Open({ title: 'Erreur' }, (inputs, outputs) => {
                outputs.p['main-text'].textContent = 'Une erreur est survenue lors de la modification de la catégorie.';
            });
            return;
        }
        page.Load('passwords');
    }

    /**
     * @param {HTMLElement} cell
     */
    async ShowPassword(cell) {
        if (this.loading) {
            return;
        }

        const [ closeType, results ] = await this.popupVerify.Open({ atEnd: 'blur' });
        if (closeType !== 'btn-unlock') {
            this.popupVerify.Close();
            return;
        }

        this.loading = true;
        const id = parseInt(cell.parentElement.getAttribute('data-id')) || 0;
        const password = results.inputs['input-password'];
        const icon = cell.getElementsByTagName('i')[0];
        const text = cell.getElementsByTagName('p')[0];

        const data = { action: 'show', id, password };
        const response = await Request_Async('./passwords', data);
        this.popupVerify.Close();

        if (response.status === 200) {
            if (response.content['status'] === 'ok') {
                const initPasswordContent = text.textContent;
                text.textContent = response.content['content'];
                icon.style.display = 'none';

                setTimeout(() => {
                    text.textContent = initPasswordContent;
                    icon.style.display = 'inline-block';
                }, 10 * 1000);
            } else if (response.content['status'] === 'wrong') {
                this.popupMessage.Open({}, (inputs, outputs) => {
                    outputs.p['main-text'].textContent = 'Le mot de passe est incorrect.';
                });
            }
        } else {
            this.popupMessage.Open({}, (inputs, outputs) => {
                outputs.p['main-text'].textContent = 'Une erreur est survenue';
            });
        }

        this.loading = false;
    }
    async AddPassword(categoryName) {
        const [ closeType, results ] = await this.popupAdd.Open({ atEnd: 'blur' }, (inputs, outputs) => {
            inputs.inputs['input-category'].value = categoryName;
        });
        if (closeType !== 'btn-save') {
            this.popupAdd.Close();
            return;
        }

        const data = {
            action: 'add',
            category: results.inputs['input-category'],
            service: results.inputs['input-service'],
            username: results.inputs['input-username'],
            password: results.inputs['input-password'],
            status: results.selects['input-status']
        };
        const response = await Request_Async('./passwords', data);
        const success = response.status === 200 && response.content['status'] === 'ok';

        if (success) {
            page.Load('passwords');
        }
    }
}

new Passwords();