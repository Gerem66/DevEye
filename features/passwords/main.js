/**
 * @typedef {Object} Password
 * @property {string} service
 * @property {string} username
 * @property {string} password
 * @property {string} status
 */

class Passwords extends Feature {
    constructor() {
        super('passwords');
    }

    onMount(category) {
        this.category = category;

        // Popups
        this.popupPassword = new Popup('popup-password');
        this.popupMessage = new Popup('popup-message');
        this.popupVerify = new Popup('popup-verify');
        this.popupEditCategory = new Popup('popup-edit-category');
        this.popupRemove = new Popup('popup-remove');
        this.popupMovePassword = new Popup('popup-move-password');

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

        // Other buttons
        const buttons = document.getElementsByName('icon-other');
        buttons.forEach(button => {
            button.parentElement.style.position = 'relative';
            const row = button.parentElement.parentElement;
            const table = row.parentElement.parentElement;
            const card = table.parentElement.parentElement;

            const id = row.getAttribute('data-id') || null;
            const category = card.getAttribute('data-title') || null;
            if (id === null || category === null) return;

            const buttonClick = (ev) => {
                const position = { x: ev.pageX, y: ev.pageY - 50 };
                new Toolbar(document.body, position, [
                    { name: 'edit', icon: 'edit', title: 'Modifier' },
                    { name: 'move', icon: 'move-to-right', title: 'Déplacer' },
                    { name: 'remove', icon: 'trash', title: 'Supprimer' }
                ], (name) => this.Other(id, category, name));
            }
            button.onclick = buttonClick;
            button.onmouseenter = buttonClick;
        });

        this.SetAllCounters(true);
    }

    SetAllCounters(first = false) {
        let total = 0;

        const tables = Array.from(document.getElementsByTagName('table'));
        tables.forEach(table => {
            const card = table.parentElement.parentElement;
            let title = card.getAttribute('data-title');
            if (title === null) return;
            if (first) card.setAttribute('data-title-length', title.length);
            else title = title.slice(0, card.getAttribute('data-title-length'));

            const tbody = table.getElementsByTagName('tbody')[0];
            const lines = Array.from(tbody.getElementsByTagName('tr'));
            const linesOn = lines.filter(line => line.style.display !== 'none');
            card.setAttribute('data-title', `${title} (${linesOn.length})`);
            total += linesOn.length;
        });

        const cardSearch = document.getElementById('card-search');
        let title = cardSearch.getAttribute('data-title');
        if (first) cardSearch.setAttribute('data-title-length', title.length);
        else title = title.slice(0, cardSearch.getAttribute('data-title-length'));
        cardSearch.setAttribute('data-title', `${title} (${total})`);
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
            const card = table.parentElement.parentElement;
            const title = card.getAttribute('data-title');
            if (title === null) return;

            const tbody = table.getElementsByTagName('tbody')[0];
            const lines = Array.from(tbody.getElementsByTagName('tr'));
            const linesOn = lines.filter(line => line.style.display !== 'none');
            card.style.display = linesOn.length === 0 ? 'none' : 'block';
        });

        this.SetAllCounters();
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
            old: results.inputs['input-category-old'],
            new: results.inputs['input-category-new']
        };
        const response = await this.CallAction('categoryEdit', data);
        if (response !== 'ok') {
            this.popupMessage.Open({ title: 'Erreur' }, (inputs, outputs) => {
                outputs.p['main-text'].textContent = 'Une erreur est survenue lors de la modification de la catégorie.';
            });
            return;
        }

        this.popupEditCategory.Close();
        await Sleep(200);
        deveye.Load('passwords');
    }

    /** 
     * Open popup to verify user password & return password with 'id'
     * @param {number} id
     * @returns {Promise<Password|null>} password object or null if user cancel or password is wrong
     */
    async GetPassword(id) {
        const [ closeType, results ] = await this.popupVerify.Open();
        if (closeType !== 'btn-unlock') {
            return null;
        }

        const password = results.inputs['input-password'];
        const data = { id, password };
        const response = await this.CallAction('getPassword', data);

        if (response === 'error') {
            this.popupMessage.Open({ title: 'Erreur' }, (inputs, outputs) => {
                outputs.p['main-text'].textContent = 'Une erreur est survenue';
            });
            return null;
        }

        if (response === 'wrong') {
            this.popupMessage.Open({ title: 'Erreur' }, (inputs, outputs) => {
                outputs.p['main-text'].textContent = 'Le mot de passe est incorrect.';
            });
            return null;
        }

        return JSON.parse(response);
    }

    /**
     * @param {HTMLElement} cell
     */
    async ShowPassword(cell) {
        cell.classList.add('blur');
        const id = parseInt(cell.parentElement.getAttribute('data-id')) || 0;
        const icon = cell.getElementsByTagName('i')[0];
        const text = cell.getElementsByTagName('p')[0];

        const password = await this.GetPassword(id);
        cell.classList.remove('blur');
        if (password === null) return;

        const initPasswordContent = text.textContent;
        text.textContent = password.password;
        icon.style.display = 'none';

        setTimeout(() => {
            text.textContent = initPasswordContent;
            icon.style.display = 'inline-block';
        }, 10 * 1000);

    }
    async AddPassword(categoryName) {
        const settings = { title: 'Ajouter un mot de passe', atEnd: 'blur' };
        const [ closeType, results ] = await this.popupPassword.Open(settings, (inputs) => {
            inputs.inputs['input-category'].value = categoryName;
        });
        if (closeType !== 'btn-save') {
            this.popupPassword.Close();
            return;
        }

        const data = {
            category: results.inputs['input-category'],
            service: results.inputs['input-service'],
            username: results.inputs['input-username'],
            password: results.inputs['input-password'],
            status: results.selects['input-status']
        };
        const response = await this.CallAction('add', data);
        if (response === 'ok') {
            this.popupPassword.Close();
            await Sleep(200);
            deveye.Load('passwords');
        }
    }

    /**
     * @param {Number} id
     * @param {string} category
     * @param {'edit'|'move'|'remove'} name
     */
    Other(id, category, name) {
        if (name === 'edit') this.EditPassword(id, category);
        if (name === 'move') this.MovePassword(id, category);
        else if (name === 'remove') this.RemovePassword(id);
    }

    async EditPassword(id, category) {
        const password = await this.GetPassword(id);
        if (password === null) return;

        const settings = { title: 'Modification d\'un mot de passe', atEnd: 'blur' };
        const [ closeType, results ] = await this.popupPassword.Open(settings, (inputs) => {
            const options = Array.from(inputs.selects['input-status'].getElementsByTagName('option'));
            inputs.inputs['input-category'].value = category;
            inputs.inputs['input-service'].value = password.service;
            inputs.inputs['input-username'].value = password.username;
            inputs.inputs['input-password'].value = password.password;
            inputs.selects['input-status'].selectedIndex = options.findIndex(option => option.value === password.status);
        });

        if (closeType !== 'btn-save') {
            this.popupPassword.Close();
            return;
        }

        const data = {
            id,
            category: results.inputs['input-category'],
            service: results.inputs['input-service'],
            username: results.inputs['input-username'],
            password: results.inputs['input-password'],
            status: results.selects['input-status']
        };
        const response = await this.CallAction('edit', data);
        if (response !== 'ok') {
            this.popupMessage.Open({ title: 'Erreur' }, (inputs, outputs) => {
                outputs.p['main-text'].textContent = 'Une erreur est survenue';
            });
            this.popupPassword.Close();
            return;
        }

        this.popupPassword.Close();
        await Sleep(200);
        deveye.Load('passwords');
    }

    async MovePassword(id, category) {
        const [ closeType, results ] = await this.popupMovePassword.Open({ atEnd: 'blur' }, (inputs, outputs) => {
            inputs.inputs['input-category'].placeholder = category;
        });
        if (closeType !== 'btn-move') {
            this.popupMovePassword.Close();
            return;
        }

        const data = { id, category: results.inputs['input-category'] };
        const response = await this.CallAction('move', data);
        this.popupMovePassword.Close();

        if (response !== 'ok') {
            this.popupMessage.Open({ title: 'Erreur' }, (inputs, outputs) => {
                outputs.p['main-text'].textContent = 'Une erreur est survenue lors de la suppression du mot de passe.';
            });
            return;
        }

        this.popupMovePassword.Close();
        await Sleep(200);
        deveye.Load('passwords');
    }

    async RemovePassword(id) {
        const [ closeType, results ] = await this.popupRemove.Open({ atEnd: 'blur' });
        if (closeType !== 'btn-remove') {
            this.popupRemove.Close();
            return;
        }

        const data = { id, password: results.inputs['input-password'] };
        const response = await this.CallAction('remove', data);
        this.popupRemove.Close();
        if (response !== 'ok') {
            this.popupMessage.Open({ title: 'Erreur' }, (inputs, outputs) => {
                outputs.p['main-text'].textContent = 'Une erreur est survenue lors de la suppression du mot de passe.';
            });
            return;
        }

        this.popupRemove.Close();
        await Sleep(200);
        deveye.Load('passwords');
    }
}

new Passwords();