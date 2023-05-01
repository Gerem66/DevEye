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

        // Show passwords
        const eyes = document.getElementsByName('icon-show-password');
        eyes.forEach(eye => eye.onclick = () => this.ShowPassword(eye.parentElement));

        // Search passwords
        const inputSearch = document.getElementById('input-search');
        inputSearch.oninput = () => this.Search(inputSearch.value.toLowerCase());

        this.SetAllCounters(true);
        this.Search('');

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
            const categoryLength = card.getAttribute('data-title-length') || 0;
            const category = card.getAttribute('data-title').slice(0, categoryLength) || null;
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

            let show = true;
            const cols = Array.from(line.getElementsByTagName('td'));

            // Search in title (true if found or search = *)
            const title = cols[0].textContent.toLowerCase();
            show &= search === '*' || title.includes(search);

            // Default, hide disabled passwords
            const status = cols[cols.length - 2].getAttribute('data-status');
            if (!search && status !== 'enable') {
                show = false;
            }

            line.style.display = show ? 'table-row' : 'none';
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
        const [ closeType, results ] = await this.popups['edit-category'].Open({ atEnd: 'blur' }, (inputs, outputs) => {
            inputs.inputs['input-category-old'].value = category;
        });
        if (closeType !== 'btn-edit') {
            this.popups['edit-category'].Close();
            return;
        }

        const data = {
            old: results.inputs['input-category-old'],
            new: results.inputs['input-category-new']
        };
        const response = await this.CallAction('categoryEdit', data);
        this.popups['edit-category'].Close();

        if (response === null || response['status'] !== 'ok') {
            this.popups['message'].Open({ title: 'Erreur' }, (inputs, outputs) => {
                outputs.p['main-text'].textContent = 'Une erreur est survenue lors de la modification de la catégorie.';
            });
            return;
        }

        await Sleep(200);
        deveye.Load('passwords');
    }

    /** 
     * Open popup to verify user password & return password with 'id'
     * @param {number} id
     * @returns {Promise<Password|null>} password object or null if user cancel or password is wrong
     */
    async GetPassword(id) {
        const [ closeType, results ] = await this.popups['verify'].Open({ atEnd: 'blur' });
        if (closeType !== 'btn-unlock') {
            this.popups['verify'].Close();
            return null;
        }

        const password = results.inputs['input-password'];
        const data = { id, password };
        const response = await this.CallAction('getPassword', data);
        this.popups['verify'].Close();

        if (response === null || response['status'] === 'error') {
            this.popups['message'].Open({ title: 'Erreur' }, (inputs, outputs) => {
                outputs.p['main-text'].textContent = 'Une erreur est survenue';
            });
            return null;
        }

        if (response['status'] === 'wrong') {
            this.popups['message'].Open({ title: 'Erreur' }, (inputs, outputs) => {
                outputs.p['main-text'].textContent = 'Le mot de passe est incorrect.';
            });
            return null;
        }

        return response['password'];
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
        const [ closeType, results ] = await this.popups['password'].Open(settings, (inputs) => {
            inputs.inputs['input-category'].value = categoryName;
            inputs.buttons['btn-save'].textContent = 'Ajouter';
        });
        if (closeType !== 'btn-save') {
            this.popups['password'].Close();
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
        if (response !== null && response['status'] === 'ok') {
            this.popups['password'].Close();
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
        const [ closeType, results ] = await this.popups['password'].Open(settings, (inputs) => {
            const options = Array.from(inputs.selects['input-status'].getElementsByTagName('option'));
            inputs.inputs['input-category'].value = category;
            inputs.inputs['input-service'].value = password.service;
            inputs.inputs['input-username'].value = password.username;
            inputs.inputs['input-password'].value = password.password;
            inputs.selects['input-status'].selectedIndex = options.findIndex(option => option.value === password.status);
            inputs.buttons['btn-save'].textContent = 'Modifier';
        });

        if (closeType !== 'btn-save') {
            this.popups['password'].Close();
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
        this.popups['password'].Close();

        if (response === null || response['status'] !== 'ok') {
            this.popups['message'].Open({ title: 'Erreur' }, (inputs, outputs) => {
                outputs.p['main-text'].textContent = 'Une erreur est survenue';
            });
            return;
        }

        await Sleep(200);
        deveye.Load('passwords');
    }

    async MovePassword(id, category) {
        const [ closeType, results ] = await this.popups['move-password'].Open({ atEnd: 'blur' }, (inputs, outputs) => {
            inputs.inputs['input-category'].placeholder = category;
        });
        if (closeType !== 'btn-move') {
            this.popups['move-password'].Close();
            return;
        }

        const data = { id, category: results.inputs['input-category'] };
        const response = await this.CallAction('move', data);
        this.popups['move-password'].Close();

        if (response === null || response['status'] !== 'ok') {
            this.popups['message'].Open({ title: 'Erreur' }, (inputs, outputs) => {
                outputs.p['main-text'].textContent = 'Une erreur est survenue lors de la suppression du mot de passe.';
            });
            return;
        }

        this.popups['move-password'].Close();
        await Sleep(200);
        deveye.Load('passwords');
    }

    async RemovePassword(id) {
        const [ closeType, results ] = await this.popups['remove'].Open({ atEnd: 'blur' });
        if (closeType !== 'btn-remove') {
            this.popups['remove'].Close();
            return;
        }

        const data = { id, password: results.inputs['input-password'] };
        const response = await this.CallAction('remove', data);
        this.popups['remove'].Close();
        if (response !== null && response['status'] === 'ok') {
            this.popups['message'].Open({ title: 'Erreur' }, (inputs, outputs) => {
                outputs.p['main-text'].textContent = 'Une erreur est survenue lors de la suppression du mot de passe.';
            });
            return;
        }

        this.popups['remove'].Close();
        await Sleep(200);
        deveye.Load('passwords');
    }
}

new Passwords();