const PLACEHOLDER = `# Titre principal
1er paragraphe, texte en *italique* et en **gras**.
2e paragraphe, texte en __souligné__ et en --barré--.

## Titre secondaire
- Liste à puce
- Liste à puce
-- Sous-liste
--- Sous-sous-liste
---- ...

+ Liste numérotée
+ Liste numérotée
++ Sous-liste
+++ Sous-sous-liste
++++ ...

### Titre tertiaire
- [] Case cochable (au clic)
- [ ] Case cochable
- [x] Case cochée
- [v] Case cochée`;

class Notes extends Feature {
    constructor() {
        super('notes');
    }

    onMount(category) {
        this.category = category;

        this.editing = false;
        this.currentNote = null;

        this.popup = new Popup('popup-message');
        this.popupDelete = new Popup('popup-delete');

        this.notesContainer = document.getElementById('notes-list');
        this.getNotesList = () => Array.from(this.notesContainer.getElementsByTagName('li'))
        this.getNotesList().forEach(li => li.onclick = () => this.loadNote(li, li.getAttribute('data-id')));
        this.noteContainer = document.getElementById('note-container');
        document.getElementById('btn-notes-add').onclick = () => this.noteAdd();

        this.noteTitle = document.getElementById('note-title');
        this.noteContent = document.getElementById('note-content');
        this.noteDate = document.getElementById('note-date');
        this.noteDateLast = document.getElementById('note-date-last');
        this.btnEdit = document.getElementById('btn-edit');
        this.btnDelete = document.getElementById('btn-delete');

        // Define title editing input
        this.inputTitle = document.createElement('input');
        this.inputTitle.classList.add('form-input', 'input-title');
        this.inputTitle.type = 'text';
        this.inputTitle.maxLength = 128;
        // Textarea for content editing
        this.inputContent = document.createElement('textarea');
        this.inputContent.classList.add('form-input');
        this.inputContent.placeholder = PLACEHOLDER;
        this.inputContent.style.whiteSpace = 'pre';
        this.inputContent.style.overflowX = 'auto';
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
        const response = await Request_Async('./notes', data);
        const success = response.status === 200 && response.content['status'] === 'ok';

        // Wait for animation
        const t2 = performance.now();
        const time = t2 - t1;
        if (time < 200 && alreadyActive) await Sleep(200 -  time);

        if (success) {
            this.showNote(response.content);
        }
    }

    isEditing() {
        if (this.editing) {
            this.popup.Open({ title: 'Attention' }, (inputs, outputs) => {
                outputs.p['main-text'].textContent = 'Une note est en cours de modification, enregistrez ou annulez pour continuer.';
            });
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
        this.currentNote = note;
        const { id, title, content, rawContent, last, date } = this.currentNote;

        this.editing = false;
        this.noteTitle.textContent = title;
        this.noteContent.innerHTML = content;
        this.noteDate.textContent = date;
        this.noteDateLast.textContent = last;
        this.noteContainer.classList.add('active');

        // Load checkable squares
        const images = Array.from(this.noteContent.getElementsByTagName('i'));
        const checkables = images.filter(i => i.getAttribute('name') === 'checkable');
        checkables.forEach(i => {
            const squareID = i.getAttribute('data-id');
            i.onclick = async () => {
                i.classList.add('blur');
                const data = { checkSquare: squareID, 'noteID': id };
                const response = await Request_Async('./notes', data);
                const success = response.status === 200 && response.content['status'] === 'ok';
                if (success) {
                    i.classList.toggle('icon-square-check');
                    i.classList.toggle('icon-square-empty');
                    this.currentNote.content = response.content['content'];
                    this.currentNote.rawContent = response.content['rawContent'];
                }
                i.classList.remove('blur');
            }
        });

        this.updateButtons(this.noteEdit, this.noteDelete);
    }

    /**
     * Set callbacks to buttons and update icons depending on 'editing' state
     * @param {Function} callback1 
     * @param {Function} callback2 
     */
    updateButtons = (callback1, callback2) => {
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

            this.showNote(response.content);
            this.noteEdit();
        }
    }
    noteEdit() {
        const { title, rawContent } = this.currentNote;

        this.editing = true;
        this.updateButtons(this.noteSave, this.noteEditCancel);

        // Title input
        this.inputTitle.value = title;
        this.noteTitle.replaceWith(this.inputTitle);

        // Content textarea
        const updateRows = () => {
            const rows = this.inputContent.value.split('\n').length;
            const minRows = 3;
            const rowsPlaceholder = this.inputContent.placeholder.split('\n').length;
            if (this.inputContent.value.length === 0) {
                this.inputContent.rows = rowsPlaceholder;
            } else {
                this.inputContent.rows = Math.max(rows, minRows);
            }
        };

        this.noteContent.innerHTML = '';
        this.noteContent.append(this.inputContent);
        this.inputContent.oninput = updateRows;
        this.inputContent.value = rawContent;
        updateRows.bind(this.inputContent)();
    }
    noteEditCancel() {
        const { content } = this.currentNote;
        this.noteContent.innerHTML = content;
        this.editing = false;
        this.inputTitle.replaceWith(this.noteTitle);
        this.showNote(this.currentNote);
        //this.updateButtons(this.noteEdit, this.noteDelete);
    }
    async noteSave() {
        const { id } = this.currentNote;
        const newTitle = this.inputTitle.value;
        const newContent = this.inputContent.value;
        this.updateButtons(() => {}, () => {});

        const data = { 'setContent': id, newTitle, newContent };
        const response = await Request_Async('./notes', data);
        const success = response.status === 200 && response.content['status'] === 'ok';

        if (success) {
            this.noteTitle.textContent = newTitle;
            const li = this.getNotesList().find(li => li.classList.contains('active')) || null;
            if (li !== null) {
                li.firstChild.textContent = newTitle;
                const savedLi = li.cloneNode(true);
                savedLi.onclick = () => this.loadNote(savedLi, savedLi.getAttribute('data-id'));
                li.remove();
                this.notesContainer.insertAdjacentElement('afterbegin', savedLi);
            }
        }
        this.inputTitle.replaceWith(this.noteTitle);
        this.showNote(response.content);
    }
    async noteDelete() {
        const { id, title, content, rawContent, date } = this.currentNote;
        const [ closeTypes, results ] = await this.popupDelete.Open({ atEnd: 'blur' });
        if (closeTypes !== 'btn-delete') {
            this.popupDelete.Close();
            return;
        }

        const data = { 'removeNote': id };
        const response = await Request_Async('./notes', data);
        const success = response.status === 200 && response.content['status'] === 'ok';
        if (success) {
            this.getNotesList().forEach(li => li.classList.contains('active') && li.remove());
            this.hideNote();
        }
        this.popupDelete.Close();
    }
}

new Notes();