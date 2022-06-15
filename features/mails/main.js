class Mails extends Feature {
    constructor() {
        super('mails');
    }

    onMount(category) {
        this.category = category;
        this.loading = false;

        const addButton = document.getElementById('mail-add');
        addButton.onclick = this.AddMail.bind(this);

        this.accounts = Array.from(document.getElementsByName('mail-account'));
        this.accounts.forEach(account => account.onclick = () => this.onClickAccount(account));

        this.mailboxFolders = document.getElementById('mailbox-folders');
        this.mailboxContent = document.getElementById('mailbox-content');
    }
    async onUnmount() {
    }

    async AddMail() {
        const [ closeType, results ] = await this.popups['mail'].Open({ title: 'Ajouter une boîte mail', atEnd: 'blur' });
        if (closeType === 'btn-save') {
            const Name = results.inputs['input-name'];
            const Email = results.inputs['input-address'];
            const Server = results.inputs['input-server'];
            const Password = results.inputs['input-password'];

            const data = { Name, Email, Server, Password };
            const response = await this.CallAction('add', data);
            const result = StrIsJson(response) ? JSON.parse(response) : null;

            if (result['status'] !== 'ok') {
                // TODO - Show error message popup
            } else {
                // TODO - Add mail & show mails
            }
        }
        this.popups['mail'].Close();
    }

    async onClickAccount(accountRow) {
        if (this.loading) return;
        if (accountRow.classList.contains('active')) return;

        this.accounts.forEach(account => account.classList.remove('active'));
        accountRow.classList.add('mail-loading');

        const accountID = accountRow.getAttribute('data-id');
        const success = await this.OpenMail(accountID);

        if (success) accountRow.classList.add('active');
        accountRow.classList.remove('mail-loading');
    }

    async onClickFolder(accountID, folderRow) {
        if (this.loading) return;

        const folders = Array.from(this.mailboxFolders.getElementsByTagName('li'));
        folders.forEach(folder => folder.classList.remove('active'));
        folderRow.classList.add('mail-loading');

        const folderName = folderRow.getAttribute('data-folder');
        const success = await this.OpenMail(accountID, folderName);

        if (success) folderRow.classList.add('active');
        folderRow.classList.remove('mail-loading');
    }

    /**
     * @param {number} accountID Number of the account in the database
     * @param {string} folder Folder mail to load (null to load inbox, and all folders names)
     * @returns {Promise<boolean>} True if the mailbox is loaded
     */
    async OpenMail(accountID, folder = null) {
        if (this.loading) return;
        this.loading = true;

        let data = { accountID, getFolders: folder === null };
        if (folder !== null) data['folder'] = folder;
        const response = await this.CallAction('get', data);
        const success = response !== null && response['status'] === 'ok';

        if (success) {
            this.mailboxContent.innerHTML = response['mails'];

            if (folder === null) {
                this.mailboxFolders.classList.remove('hide');
                this.mailboxFolders.innerHTML = response['folders'];
                const folders = Array.from(this.mailboxFolders.getElementsByTagName('li'));
                folders.forEach(folder => folder.onclick = () => this.onClickFolder(accountID, folder));
            }
        }

        this.loading = false;
        return success;
    }
}

new Mails();