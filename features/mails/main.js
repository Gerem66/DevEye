class Mails extends Feature {
    constructor() {
        super('mails');
    }

    onMount(category) {
        this.category = category;
        this.loading = false;
        this.accountID = null;

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

            this.popups['mail'].Close();

            if (result['status'] !== 'ok') {
                this.popups['message'].Open({ title: 'Erreur' }, (inputs, outputs) => {
                    outputs.p['main-text'].textContent = 'Une erreur est survenue lors de l\'ajout de la boîte mail.';
                });
                return;
            }

            await Sleep(200);
            deveye.Load('mails');
        }
        this.popups['mail'].Close();
    }

    async onClickAccount(accountRow) {
        if (this.loading) return;
        if (accountRow.classList.contains('active')) return;

        this.accounts.forEach(account => account.classList.remove('active'));
        accountRow.classList.add('mail-loading');

        const accountID = accountRow.getAttribute('data-id');
        const success = await this.OpenMailbox(accountID);

        if (success) {
            this.accountID = accountID;
            accountRow.classList.add('active');
        }
        accountRow.classList.remove('mail-loading');
    }

    async onClickFolder(accountID, folderRow) {
        if (this.loading) return;
        if (folderRow.classList.contains('active')) return;

        const folders = Array.from(this.mailboxFolders.getElementsByTagName('li'));
        folders.forEach(folder => folder.classList.remove('active'));
        folderRow.classList.add('mail-loading');

        const folderName = folderRow.getAttribute('data-folder');
        const success = await this.OpenMailbox(accountID, folderName);

        if (success) folderRow.classList.add('active');
        folderRow.classList.remove('mail-loading');
    }

    async onClickMail(e, mailRow) {
        if (this.loading) return;
        if (this.accountID === null) return;
        if (e.target.tagName === 'INPUT') return;

        const iframe = document.getElementsByName('mail-content')[0];
        const name = mailRow.getElementsByClassName('mailbox-name')[0].textContent;
        const subject = mailRow.getElementsByClassName('mailbox-subject')[0].textContent;

        // Open loading popup
        let btnHeader = null;
        const title = `${name} - ${subject}`;
        this.popups['mail-content'].Open({ title }, (inputs, outputs) => {
            inputs.buttons['mail-close'].onclick = () => this.popups['mail-content'].Close();
            btnHeader = inputs.buttons['mail-get-header'];
            btnHeader.style.display = 'none';

            const blob = new Blob([ "<p>Chargement...</p>" ], { type: 'text/html' });
            iframe.src = URL.createObjectURL(blob);
        });

        const mailno = mailRow.getAttribute('data-no');
        const mail = await this.GetMail(mailno);

        if (mail === false) {
            this.popups['mail-content'].Close();
            this.popups['message'].Open({ title: 'Erreur' }, (inputs, outputs) => {
                outputs.p['main-text'].textContent = 'Une erreur est survenue lors de la lecture du mail.';
            });
            return;
        }

        // Show header button
        if (btnHeader !== null) {
            btnHeader.style.display = 'block';
            btnHeader.onclick = () => {
                this.popups['mail-header'].Open({ title: 'Mail header' }, (inputs, outputs) => {
                    outputs.p['main-text'].innerHTML = mail.head.replaceAll('\r\n', '<br>');
                });
            }
        }

        mailRow.classList.remove('unseen');
        const blob = new Blob([mail.body], { type: 'text/html' });
        iframe.src = URL.createObjectURL(blob);
    }

    /**
     * @param {number} accountID Number of the account in the database
     * @param {string} folder Folder mail to load (null to load inbox, and all folders names)
     * @returns {Promise<boolean>} True if the mailbox is loaded
     */
    async OpenMailbox(accountID, folder = null) {
        if (this.loading) return;
        this.loading = true;

        let data = { accountID, getFolders: folder === null };
        if (folder !== null) data['folder'] = folder;
        const response = await this.CallAction('get', data);
        const success = response !== null && response['status'] === 'ok';

        if (success) {
            this.mailboxContent.innerHTML = response['mails'];
            const mails = Array.from(this.mailboxContent.getElementsByTagName('tr'));
            mails.forEach(mail => mail.onclick = (e) => this.onClickMail(e, mail));

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

    /**
     * @param {number} mailno 
     * @returns {Promise<{head: string, body: string}|false>} HTML of the mail content, or false if the mail doesn't exist
     */
    async GetMail(mailno) {
        if (this.loading) return false;
        this.loading = true;
    
        const data = { accountID: this.accountID, mailno };
        const content = await this.CallAction('read', data);

        this.loading = false;
        if (content !== null && content['status'] === 'ok') {
            const output = {
                head: content['head'],
                body: content['body']
            };
            return output;
        }
        return false;
    }
}

new Mails();