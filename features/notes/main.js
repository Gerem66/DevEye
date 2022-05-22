class Notes extends Feature {
    constructor() {
        super('notes');
    }

    onMount(category) {
        this.category = category;

        this.editing = false;
        this.currentNote = null;
        this.inputContent = null;

        this.popup = new Popup('popup-message');
        this.popup.popup.getElementsByTagName('button')[0].onclick = () => this.popup.Close();
        this.popupDelete = new Popup('popup-delete');
        this.popupDelete.popup.getElementsByClassName('btn-delete-back')[0].onclick = () => this.popupDelete.Close();

        this.notesContainer = document.getElementById('notes-list');
        this.getNotesList = () => Array.from(this.notesContainer.getElementsByTagName('li'))
        this.getNotesList().forEach(li => li.onclick = () => this.loadNote(li, li.getAttribute('data-id')));
        this.noteContainer = document.getElementById('note-container');
        document.getElementById('btn-notes-add').onclick = () => this.noteAdd();

        this.noteTitle = document.getElementById('note-title');
        this.noteTitleInput = null;
        this.noteContent = document.getElementById('note-content');
        this.noteDate = document.getElementById('note-date');
        this.btnEdit = document.getElementById('btn-edit');
        this.btnDelete = document.getElementById('btn-delete');
    }
    async onUnmount() {
    }

    async loadNote(li, id) {
        if (this.isEditing()) {
            return;
        }

        const alreadyActive = this.noteContainer.classList.contains('active');
        this.hideNote();
        li?.classList.add('active');

        // Load note
        const t1 = performance.now();
        const data = { getContent: id };
        const note = await Request_Async('./notes', data);
        const success = note.status === 200 && note.content['status'] === 'ok';

        // Wait for animation
        const t2 = performance.now();
        const time = t2 - t1;
        if (time < 200 && alreadyActive) await Sleep(200 -  time);

        if (success) {
            this.showNote(note);
        }
    }

    isEditing() {
        if (this.editing) {
            this.popup.popup.getElementsByTagName('p')[0].innerHTML = 'Une note est en cours de modification, enregistrez ou annulez pour continuer.';
            this.popup.Open();
            return true;
        }
        return false;
    }

    hideNote() {
        this.btnEdit.onclick = null;
        this.btnDelete.onclick = null;
        this.getNotesList().forEach(li => li.classList.remove('active'))
        this.noteContainer.classList.remove('active');
    }

    showNote(note) {
        this.currentNote = note.content;
        const { title, content, rawContent, date } = this.currentNote;

        this.editing = false;
        this.noteTitle.textContent = title;
        this.noteContent.innerHTML = content;
        this.noteDate.textContent = date;
        this.noteContainer.classList.add('active');

        this.updateButtons(this.noteEdit, this.noteDelete);
    }

    /**
     * Set callbacks to buttons and update icons depending on 'editing' state
     * @param {Function} callback1 
     * @param {Function} callback2 
     */
    updateButtons(callback1, callback2) {
        this.btnEdit.classList.toggle('icon-edit', !this.editing);
        this.btnEdit.classList.toggle('icon-v', this.editing);
        this.btnEdit.title = this.editing ? 'Enregistrer les modifications' : 'Modifier la note';
        this.btnEdit.onclick = callback1.bind(this);

        this.btnDelete.classList.toggle('icon-trash', !this.editing);
        this.btnDelete.classList.toggle('icon-x', this.editing);
        this.btnDelete.title = this.editing ? 'Annuler les modifications' : 'Supprimer la note';
        this.btnDelete.onclick = callback2.bind(this);
    }

    async noteAdd() {
        if (this.isEditing()) {
            return;
        }

        const data = { 'addNote': 1 };
        const response = await Request_Async('./notes', data);
        const success = response.status === 200 && response.content['status'] === 'ok';
        if (success) {
            this.hideNote();
            const id = response.content['id'];
            const title = response.content['title'];

            const newLi = document.createElement('li');
            newLi.onclick = () => this.loadNote(newLi, id);
            newLi.innerHTML = `<p>${title}</p>`;
            newLi.classList.add('active');
            newLi.setAttribute('data-id', id);
            this.notesContainer.insertAdjacentElement('afterbegin', newLi);
            this.showNote(response);
        }
    }
    noteEdit() {
        const { title, rawContent } = this.currentNote;

        this.editing = true;
        this.updateButtons(this.noteSave, this.noteEditCancel);

        // Title input
        this.noteTitleInput = document.createElement('input');
        this.noteTitleInput.classList.add('form-input', 'input-title');
        this.noteTitleInput.type = 'text';
        this.noteTitleInput.value = title;
        this.noteTitleInput.maxLength = 128;
        this.noteTitle.replaceWith(this.noteTitleInput);

        // Content textarea
        this.inputContent = document.createElement('textarea');
        this.inputContent.classList.add('form-input');
        const updateRows = () => {
            const rows = this.inputContent.value.split('\n').length;
            this.inputContent.rows = rows;
        };
        this.inputContent.textContent = rawContent;
        this.inputContent.oninput = updateRows;
        updateRows();

        this.noteContent.innerHTML = '';
        this.noteContent.append(this.inputContent);
    }
    noteEditCancel() {
        const { content } = this.currentNote;
        this.noteContent.innerHTML = content;
        this.editing = false;
        this.noteTitleInput.replaceWith(this.noteTitle);
        this.updateButtons(this.noteEdit, this.noteDelete);
    }
    async noteSave() {
        const { id } = this.currentNote;
        const newTitle = this.noteTitleInput.value;
        const newContent = this.inputContent.value;

        const data = { 'setContent': id, newTitle, newContent };
        const response = await Request_Async('./notes', data);
        const success = response.status === 200 && response.content['status'] === 'ok';

        if (success) {
            this.noteTitle.textContent = newTitle;
            const li = this.getNotesList().find(li => li.classList.contains('active')) || null;
            if (li !== null) {
                li.firstChild.textContent = newTitle;
                const savedLi = li.cloneNode(true);
                li.remove();
                this.notesContainer.insertAdjacentElement('afterbegin', savedLi);
            }
        }
        this.noteTitleInput.replaceWith(this.noteTitle);
        this.showNote(response);
    }
    noteDelete() {
        const { id, title, content, rawContent, date } = this.currentNote;
        this.popupDelete.Open();
        const buttonDelete = this.popupDelete.popup.getElementsByClassName('btn-delete-delete')[0];
        buttonDelete.onclick = async () => {
            this.popupDelete.popup.classList.add('blur');
            const data = { 'removeNote': id };
            const response = await Request_Async('./notes', data);
            const success = response.status === 200 && response.content['status'] === 'ok';
            if (success) {
                this.getNotesList().forEach(li => li.classList.contains('active') && li.remove());
                this.hideNote();
            }
            this.popupDelete.popup.classList.remove('blur');
            this.popupDelete.Close();
        }
    }
}

new Notes();