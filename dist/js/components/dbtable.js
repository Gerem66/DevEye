/**
 * @typedef {Object} DBTableFeatures
 * @property {Boolean} cellchange
 * @property {Boolean} rowadd
 * @property {Boolean} rowremove
 * @property {Boolean} navigation
 */

class DBTable {
    /**
     * @description Setup database table
     * @param {HTMLElement} card Card containing the table [& navigation]
     * @param {String} tableName Name of table focused
     * @param {String} pageName Name of feature page, used for requests
     */
    constructor(card, tableName, pageName) {
        this.card = card;
        this.table = card?.getElementsByTagName('table')[0];
        this.tableName = tableName;
        this.pageName = pageName;

        // Navigation variables
        this.loading = false;
        this.currentPage = 1;
        this.lastPage = parseInt(this.table.getAttribute('data-maxpage')) || 1;

        /** @description Show success while cell was correctly edited */
        this.savedText = null;
        this.savedTextTimeout = null;

        /** @type {DBTableFeatures} */
        this.features = {
            cellchange: false,
            rowadd: false,
            rowremove: false,
            navigation: false
        };
        this.setupCellsEvents();
    }

    /** @param {keyof DBTableFeatures} feature */
    AddFeature(feature) {
        if (!this.features.hasOwnProperty(feature)) {
            throw new Error(`Feature ${feature} does not exist`);
        }
        this.features[feature] = true;

        // Setups
        if (feature === 'cellchange') {
            this.setupSaveText();
        } else if (feature === 'rowadd') {
            this.setupAddRow();
        } else if (feature === 'rowremove') {
            this.setupSaveText();
            this.setupTrash();
        } else if (feature === 'navigation') {
            this.setupNavigation();
        }
    }
    /** @param {keyof DBTableFeatures} feature */
    RemoveFeature(feature) {
        if (!this.features.hasOwnProperty(feature)) {
            throw new Error(`Feature ${feature} does not exist`);
        }
        this.features[feature] = false;
    }

    setupCellsEvents() {
        const cells = Array.from(this.table?.getElementsByTagName('td'));
        cells.forEach(cell => cell.onclick = () => this.onCellClick(cell));
    }
    setupSaveText() {
        if (this.savedText !== null) {
            return;
        }
        this.savedText = document.createElement('div');
        this.savedText.style.opacity = 0;
        this.savedText.classList.add('card-header', 'message');
        this.card.insertBefore(this.savedText, this.card.firstChild);
    }
    setupAddRow() {
        if (!this.features['rowadd']) return;
        if (!this.features['navigation']) {
            throw new Error('Navigation feature is required to add a row');
        }

        const divAdd = document.createElement('div');
        divAdd.classList.add('float-right', 'responsive');

        const buttonAdd = document.createElement('a');
        buttonAdd.classList.add('link');
        buttonAdd.textContent = 'Ajouter une ligne';
        buttonAdd.onclick = () => this.onAddRowClick();
        divAdd.append(buttonAdd);

        this.card.insertAdjacentElement('afterbegin', divAdd);
    }
    setupNavigation() {
        const isLast = this.currentPage === this.lastPage;
        const navigation = '\
            <div class="card-navigation float-center">\
                <a name="first" class="link disabled">Premier</a>\
                <a name="next" class="link disabled">Suivant</a>\
                <p name="navigation-text" class="logs-text-margin">' + this.currentPage + ' / ' + this.lastPage + '</p>\
                <a name="prev" class="link ' + (isLast && 'disabled') + '">Précédent</a>\
                <a name="last" class="link ' + (isLast && 'disabled') + '">Dernier</a>\
            </div>';
        this.card.insertAdjacentHTML('afterbegin', navigation);

        const btns = Array.from(this.card.getElementsByClassName('card-navigation')[0].getElementsByTagName('a'));
        btns.forEach(btn => {
            btn.onclick = async () => {
                if (this.loading) {
                    return;
                }

                const state = btn.getAttribute('name');
                if (state === 'next' && this.currentPage > 1) {
                    this.currentPage--;
                } else if (state === 'prev' && this.currentPage < this.lastPage) {
                    this.currentPage++;
                } else if (state === 'first' && this.currentPage !== 1) {
                    this.currentPage = 1;
                } else if (state === 'last' && this.currentPage !== this.lastPage) {
                    this.currentPage = this.lastPage;
                } else {
                    return;
                }

                const tbody = this.table.getElementsByTagName('tbody')[0];
                this.loading = true;
                tbody.classList.add('blur');

                const data = { type: 'navigation', table: this.tableName, page: this.currentPage };
                const response = await Request_Async('./' + this.pageName, data);
                const success = response.status === 200 && response.content?.status === 'ok';

                if (success) {
                    // Enable / disable buttons
                    btns.forEach(btn => {
                        const name = btn.getAttribute('name');
                        if ((name === 'first' || name === 'next') && this.currentPage === 1) {
                            btn.classList.add('disabled');
                        } else if ((name === 'prev' || name === 'last') && this.currentPage === this.lastPage) {
                            btn.classList.add('disabled');
                        } else {
                            btn.classList.remove('disabled');
                        }
                    });

                    // Execute response
                    this.currentPage = response.content.newPage || 1;
                    this.lastPage = response.content.maxPage || 1;
                    tbody.innerHTML = response.content.content || '';
                    this.setupCellsEvents();
                    this.setupTrash(false);

                    const text = this.card.getElementsByTagName('p')[0];
                    text.textContent = this.currentPage + ' / ' + this.lastPage;
                } else {
                    this.showSavedText(false);
                }

                this.loading = false;
                tbody.classList.remove('blur');
            }
        });
    }
    setupTrash(setupHeader = true) {
        if (!this.features['rowremove']) {
            return;
        }

        if (setupHeader) {
            const tr = this.table.getElementsByTagName('thead')[0].getElementsByTagName('tr')[0];
            const th = document.createElement('th');
            th.title = 'Supprimer';
            th.textContent = 'Suppr.';
            tr.insertBefore(th, tr.firstChild);
        }

        const rows = Array.from(this.table.getElementsByTagName('tbody')[0].getElementsByTagName('tr'));
        rows.forEach(row => {
            const id = row.firstChild.getAttribute('data-id');
            const trash = document.createElement('i');
            trash.classList.add('icon', 'icon-trash');
            
            const newCell = document.createElement('td');
            newCell.style.cursor = 'pointer';
            newCell.onclick = () => this.onTrashClick(row, trash, id);
            newCell.append(trash);
            row.insertBefore(newCell, row.firstChild);
        });
    }

    /**
     * Show message (success or error) at corner of the table
     * @param {Boolean} success
     */
    showSavedText(success = true) {
        let content = "<p>Changements sauvegardés</p><img src='./assets/icons/success.svg' alt='Success icon'></img>";
        if (!success) {
            content = "<p>Une erreur est survenue</p><img src='./assets/icons/error.svg' alt='Error icon'></img>";
        }
        this.savedText.innerHTML = content;
        this.savedText.style.opacity = 1;
        clearTimeout(this.savedTextTimeout);
        this.savedTextTimeout = setTimeout(() => {
            this.savedText.style.opacity = 0;
        }, 2 * 1000);
    }

    async onAddRowClick() {
        if (this.loading) return;

        this.loading = true;
        const tbody = this.table.getElementsByTagName('tbody')[0];
        tbody.classList.add('blur');

        const data = { type: 'rowadd', table: this.tableName };
        const response = await Request_Async('./' + this.pageName, data);
        const success = response.status === 200 && response.content?.status === 'ok';

        if (success) {
            this.currentPage = 1;
            this.lastPage = response.content.maxPage;
            tbody.innerHTML = response.content.content;
            this.setupCellsEvents();
            this.setupTrash(false);

            if (this.features['navigation']) {
                const text = this.card.getElementsByTagName('p')[0];
                text.textContent = this.currentPage + ' / ' + this.lastPage;

                const btns = Array.from(this.card.getElementsByClassName('card-navigation')[0].getElementsByTagName('a'));
                btns.forEach(btn => {
                    const name = btn.getAttribute('name');
                    if ((name === 'first' || name === 'next') || this.lastPage === 1) {
                        btn.classList.add('disabled');
                    } else {
                        btn.classList.remove('disabled');
                    }
                });
            }
        }

        this.showSavedText(success);
        tbody.classList.remove('blur');
        this.loading = false;
    }

    /**
     * @param {HTMLElement} row
     * @param {HTMLElement} trash
     * @param {String} ID
     */
    async onTrashClick(row, trash, ID) {
        if (!this.features['rowremove']) {
            return;
        }

        if (!trash.classList.contains('active')) {
            trash.classList.add('active');
            trash.style.backgroundColor = '#e74c3c';
            setTimeout(() => {
                trash.classList.remove('active');
                trash.style.backgroundColor = '';
            }, 3 * 1000);
            return;
        }

        row.classList.add('blur');

        const data = { type: 'rowremove', table: this.tableName, ID, page: this.currentPage };
        const response = await Request_Async('./' + this.pageName, data);
        const success = response.status === 200 && response.content?.status === 'ok';

        if (success) {
            const tbody = this.table.getElementsByTagName('tbody')[0];
            tbody.innerHTML = response.content?.content || null;
            this.setupCellsEvents();
            this.setupTrash(false);

            // Next page if current is empty
            if (!tbody.innerHTML) {
                const btns = Array.from(this.card.getElementsByClassName('card-navigation')[0].getElementsByTagName('a'));
                this.lastPage--;
                btns.forEach(btn => btn.getAttribute('name') === 'next' && btn.click());
            }
        }

        this.showSavedText(success);
        row.classList.remove('blur');
    }

    /** @param {HTMLTableCellElement} cell */
    onCellClick(cell) {
        if (!this.features['cellchange']) {
            return;
        }

        if (!cell.classList.contains('editing')) {
            const initValue = cell.innerHTML;
            cell.classList.add('editing');
    
            // Replace text with textinput
            const input = document.createElement('input');
            input.type = 'text';
            input.value = initValue;

            cell.innerHTML = '';
            cell.appendChild(input);
            input.select();

            input.onblur = () => this.onCellValid(cell, initValue, input.value);
            input.onkeydown = (ev) => {
                if (ev.key === 'Enter' || ev.key === 'Tab') {
                    this.onCellValid(cell, initValue, input.value);
                } else if (ev.key === 'Escape') {
                    this.onCellValid(cell, initValue, initValue);
                }
            }
        }
    }

    /**
     * @param {HTMLTableCellElement} cell
     * @param {string} initValue
     * @param {string} newValue
     */
    async onCellValid(cell, initValue, newValue) {
        if (initValue !== newValue) {
            if (!cell.classList.contains('blur')) {
                cell.classList.add('blur');
            }
            const ID = cell.getAttribute('data-id');
            const column = cell.getAttribute('data-column');

            if (this.features['cellchange']) {
                const data = { type: 'cellchange', table: this.tableName, ID, column, value: newValue };
                const response = await Request_Async('./' + this.pageName, data);
                const success = response.status === 200 && response.content?.status === 'ok';
                if (!success) {
                    newValue = initValue;
                }
                this.showSavedText(success);
            }
            cell.classList.remove('blur');
        }

        cell.innerHTML = newValue;
        cell.classList.remove('editing');
    }
}