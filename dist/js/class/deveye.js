class DevEye {
    constructor() {
        /** @type {HTMLElement} */
        this.topbar;

        /** @type {HTMLElement} */
        this.content;

        /** @type {Array<Feature>} */
        this.features = {};

        /** @type {WSS?} */
        this.server = null;

        /** @type {Login?} */
        this.login = null;

        /** @type {Sidebar?} */
        this.sidebar = null;

        this.loading = false;
        this.currentFeatureName = null;
        this.defaultPage = 'user';
    }

    async Mount() {
        this.server = new WSS();
        this.login = new Login();
        const connected = await this.server.Connect();
        if (!connected) {
            this.ShowErrorMessage('Une erreur est survenue');
            return;
        }

        this.login.loginForm.classList.remove('form-hide');
        this.login.loginForm.getElementsByTagName('p')[0].classList.add('anim');
    }

    Unmount() {
        this.server?.Disconnect();
    }

    ShowErrorMessage(message) {
        this.UnmountHome();
        this.login.SetTitle('error');
        const form = document.getElementById('login-form');
        const p = document.createElement('p');
        p.style.fontSize = '1.5em';
        p.textContent = message;
        form.innerHTML = '';
        form.appendChild(p);
        form.classList.remove('form-hide');
    }

    async MountHome() {
        await this.server.LoadData();

        this.login.loginContent.classList.add('form-hide');

        this.sidebar = new Sidebar();
        this.sidebar.Mount();
        this.topbar = document.getElementById('topbar');
        this.content = document.getElementById('main-content');
        this.content.onclick = () => this.sidebar.HideSidebarOnSmallScreen();
        this.Load(this.defaultPage);
    }

    UnmountHome() {
        if (document.body.firstChild !== this.login.loginContent) {
            document.body.removeChild(document.body.firstChild);
        }
        this.login.SetTitle('login');
        this.login.disconnect();
        this.server.UserDisconnection();
    }

    /** @param {Boolean} isLoading */
    SetLoading(isLoading) {
        if (this.content === null) {
            throw new Error('Page.SetLoading: content is null');
        }
        this.loading = isLoading;
        if (isLoading) {
            this.content.classList.add('blur');
        } else {
            this.content.classList.remove('blur');
        }
    }

    /**
     * @param {Pages} page
     * @param {String} category
     * @returns {Promise<Boolean>}
     */
    async Load(page, category) {
        const time_total_1 = Date.now();
        if (this.loading) return false;
        if (this.content === null) {
            throw new Error('Page.Load: content is null');
        }

        this.sidebar.HideSidebarOnSmallScreen();
        this.sidebar.ClearActiveItems();
        await this.features[this.currentFeatureName]?.preUnmount();
        this.currentFeatureName = null;

        this.SetLoading(true);

        const time_loading_1 = Date.now();
        const content = await this.server.GetPage(page, category);
        const time_loading_2 = Date.now();

        if (content !== null) {
            this.content.innerHTML = content;
            if (this.features.hasOwnProperty(page)) {
                this.features[page]?.preMount(category);
                this.currentFeatureName = page;
            }
        }

        this.SetLoading(false);
        this.sidebar.SetActiveItem(page, category);
        const time_total_2 = Date.now();

        const time_total = time_total_2 - time_total_1;
        const time_loading = time_loading_2 - time_loading_1;
        console.log(`Page.Load (${page}): ${time_total}ms (Request: ${time_loading}ms)`);
        return content !== null;
    }

    /** @param {HTMLElement} content */
    SetContent(page, category, content) {
        if (this.content === null) {
            throw new Error('Page.SetContent: content is null');
        }

        //this.content.innerHTML = content;
        this.content.innerHTML = '';
        this.content.appendChild(content);

        this.features[page]?.preMount(category);
        this.currentFeatureName = page;

        this.SetLoading(false);
        this.sidebar.SetActiveItem(page, category);
    }
}