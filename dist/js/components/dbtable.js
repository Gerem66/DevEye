/**
 * Fires when value changed.
 * @async
 * @callback oncellchange
 * @param {String} table
 * @param {String} ID
 * @param {String} column
 * @param {String} value
 * @returns {Promise<Boolean>} True if value changed successfully, false if not.
 *
 * Fires when add row button clicked.
 * @async
 * @callback onrowadd
 * @param {String} table
 * @returns {Promise<String?>} New content if row removed successfully, null if not.
 *
 * Fires when delete row button clicked.
 * @async
 * @callback onrowremove
 * @param {String} table
 * @param {String} ID
 * @param {Number} page
 * @returns {Promise<String?>} New content if row removed successfully, null if not.
 *
 * Fires when navigation bar is used.
 * @async
 * @callback onnavigation
 * @param {String} table
 * @param {Number} newPage
 * @returns {Promise<Number, Number, String>} Return the new page number, number of last page, and the new content or null if error.
 */

/**
 * @typedef {Object} DBTableEvents
 * @property {oncellchange} oncellchange
 * @property {onrowadd} onrowadd
 * @property {onrowremove} onrowremove
 * @property {onnavigation} onnavigation
 */

class DBTable {
    /**
     * @param {HTMLElement} card Component containing the table [& navigation]
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
        this.lastPage = this.table.getAttribute('data-maxpage');

        /** @description Show success while cell was correctly edited */
        this.savedText = null;
        this.savedTextTimeout = null;

        /** @type {DBTableEvents} */
        this.events = {};
        this.setupCellsEvents();
    }

    /**
     * @typedef {keyof DBTableEvents} ev
     * @param {ev} event
     * @param {DBTableEvents[ev]} callback
     */
    AddEventListener(event, callback) {
        this.events[event] = callback;

        // Setups
        if (event === 'oncellchange') {
            this.setupSaveText();
        } else if (event === 'onrowadd') {
            this.setupAddRow();
        } else if (event === 'onrowremove') {
            this.setupSaveText();
            this.setupTrash();
        } else if (event === 'onnavigation') {
            this.setupNavigation();
        }
    }
    /**
     * @param {keyof DBTableEvents} event
     */
    RemoveEventListener(event) {
        delete this.events[event];
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
        this.savedText.classList.add('card-header');
        this.card.insertBefore(this.savedText, this.card.firstChild);
    }
    setupAddRow() {
        const divAdd = document.createElement('div');
        divAdd.classList.add('float-right');
        divAdd.style.marginTop = '-24px';

        const buttonAdd = document.createElement('a');
        buttonAdd.classList.add('link');
        buttonAdd.textContent = 'Ajouter une ligne';
        buttonAdd.onclick = () => this.onAddRowClick();
        divAdd.append(buttonAdd);

        this.card.insertAdjacentElement('afterbegin', divAdd);
    }
    setupNavigation() {
        const navigation = '\
            <div class="card-navigation float-center">\
                <a name="first" class="link disabled">Premier</a>\
                <a name="next" class="link disabled">Suivant</a>\
                <p id="navigation-text" class="logs-text-margin">' + this.currentPage + ' / ' + this.lastPage + '</p>\
                <a name="prev" class="link">Précédent</a>\
                <a name="last" class="link">Dernier</a>\
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

                const result = await this.events['onnavigation'](this.tableName, this.currentPage);
                if (result !== null) {
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
                    const [ pageNumber, maxPage, content ] = result;
                    this.currentPage = pageNumber;
                    this.lastPage = maxPage;
                    tbody.innerHTML = content;
                    this.setupCellsEvents();
                    this.setupTrash(false);

                    const text = document.getElementById('navigation-text');
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

        const result = await this.events['onrowadd'](this.tableName);
        this.showSavedText(result !== null);

        if (result !== null) {
            this.currentPage = 1;
            tbody.innerHTML = result;
            this.setupCellsEvents();
            this.setupTrash(false);

            const text = document.getElementById('navigation-text');
            text.textContent = this.currentPage + ' / ' + this.lastPage;

            const btns = Array.from(this.card.getElementsByClassName('card-navigation')[0].getElementsByTagName('a'));
            btns.forEach(btn => {
                const name = btn.getAttribute('name');
                if ((name === 'first' || name === 'next')) {
                    btn.classList.add('disabled');
                } else {
                    btn.classList.remove('disabled');
                }
            });
        }

        tbody.classList.remove('blur');
        this.loading = false;
    }

    /**
     * @param {HTMLElement} row
     * @param {HTMLElement} trash
     * @param {String} id
     */
    async onTrashClick(row, trash, id) {
        if (!this.events['onrowremove']) {
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
        const newContent = await this.events['onrowremove'](this.tableName, id, this.currentPage);
        this.showSavedText(newContent !== null);
        if (newContent !== null) {
            const tbody = this.table.getElementsByTagName('tbody')[0];
            tbody.innerHTML = newContent;
            this.setupCellsEvents();
            this.setupTrash(false);
        }
        row.classList.remove('blur');
    }

    /** @param {HTMLTableCellElement} cell */
    onCellClick(cell) {
        if (!this.events['oncellchange']) {
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

            if (this.events['oncellchange']) {
                const success = await this.events['oncellchange'](this.tableName, ID, column, newValue);
                this.showSavedText(success);
                if (!success) {
                    newValue = initValue;
                }
            }
            cell.classList.remove('blur');
        }

        cell.innerHTML = newValue;
        cell.classList.remove('editing');
    }
}