class Profile extends Feature {
    constructor() {
        super('user');

        /** @type {HTMLLIElement?} */
        this.selected = null;

        /** @type {HTMLLIElement?} */
        this.ghost = null;

        this.initPos = { x: 0, y: 0 };
        this.initIndex = 0;
    }

    onMount() {
        this.settingsFeatures = document.getElementById('settings-features');
        this.settingsDefault = document.getElementById('settings-default');

        // Define features drag & drop
        this.getFeatures = () => Array.from(this.settingsFeatures.getElementsByTagName('li'));
        this.getFeatures().forEach(this.loadFeature);
        this.settingsFeatures.onmousemove = this.onMoveFeature;
        this.settingsFeatures.onmouseleave = this.onDropFeature;
        document.onmouseup = this.onDropFeature;

        // Define default features
        this.settingsDefault.onchange = () => this.saveSettings(false);

        this.settingsSaved = document.getElementById('settings-saved');
        this.settingsSavedTimeout = null;

        // Popups
        this.popupMessage = new Popup('popup-message');
        this.popupMessage.SetCancelable(false);
        this.popupMessage.popup.getElementsByTagName('button')[0].onclick = () => this.popupMessage.Close();
        this.popup = new Popup('popup-password');
        this.popup.AddButtonClickListener(name => {
            if (name === 'btn-back') this.popup.Close();
            else if (name === 'btn-save') this.editPassword();
        });
        document.getElementById('button-password-edit').onclick = () => this.popup.Open();

        // Popup input toggle password mode
        const buttons = Array.from(this.popup.popup.getElementsByTagName('button'));
        const buttonsToggle = buttons.filter(btn => btn.name === 'btn-toggle-pwd');
        buttonsToggle.forEach(btn => btn.onclick = () => {
            const parent = btn.parentElement;
            const input = parent.getElementsByTagName('input')[0];
            input.type = input.type === 'password' ? 'text' : 'password';
            const icon = btn.getElementsByTagName('i')[0];
            icon.classList.toggle('icon-eye-open');
            icon.classList.toggle('icon-eye-close');
        });
    }
    async onUnmount() {
        clearTimeout(this.settingsSavedTimeout);
    }

    loadFeature = (feature) => {
        const [ dragIcon, eyeIcon ] = feature.getElementsByTagName('span');
        eyeIcon.onclick = () => this.onFeatureToggle(feature, eyeIcon);
        dragIcon.onmousedown = (ev) => this.onDragFeature(ev, feature);
    }
    /**
     * @param {HTMLLIElement} feature
     * @param {HTMLSpanElement} icon
     */
    onFeatureToggle = (feature, icon) => {
        if (feature.classList.contains('disabled')) {
            // Enable
            feature.classList.remove('disabled');
            icon.classList.remove('icon-eye-close');
            icon.classList.add('icon-eye-open');
        } else {
            // Disable
            feature.classList.add('disabled');
            icon.classList.remove('icon-eye-open');
            icon.classList.add('icon-eye-close');
        }
        this.saveSettings();
    }
    /**
     * @param {MouseEvent} ev
     * @param {HTMLLIElement} feature
     */
    onDragFeature = (ev, feature) => {
        //this.onDropFeature();
        this.initPos = {
            y: ev.pageY - feature.offsetTop,
            y0: feature.offsetTop
        };
        this.initIndex = this.getFeatures().indexOf(feature);
        this.ghost = feature.cloneNode(true);
        this.ghost.style.width = feature.offsetWidth + 'px';
        this.selected = feature;
        this.selected.classList.add('ghost');
        this.settingsFeatures.appendChild(this.ghost);
        this.onMoveFeature(ev);
    }
    /** @param {MouseEvent} ev */
    onMoveFeature = (ev) => {
        if (this.ghost) {
            const features = this.getFeatures();
            const currIndex = features.indexOf(this.selected);
            const deltaIndex = this.initIndex - currIndex;
            const deltaY = this.initPos.y0 - (ev.pageY - this.initPos.y);
            const height = features[0].offsetHeight;
            const relativeDeltaY = deltaIndex - deltaY / height;
            if (Math.abs(relativeDeltaY) > 0.5) {
                const diff = relativeDeltaY > 0 ? 1 : -1;
                const newIndex = MinMax(0, currIndex + diff, features.length - 1);
                if (newIndex !== currIndex) {
                    const newNode = this.selected.cloneNode(true);
                    this.selected.remove();
                    this.settingsFeatures.insertBefore(newNode, this.settingsFeatures.children[newIndex]);
                    this.selected = this.getFeatures()[newIndex];
                    this.loadFeature(this.selected);
                }
            }
            this.ghost.style.position = 'absolute';
            this.ghost.style.top = `${ev.pageY - this.initPos.y}px`;
        }
    }
    onDropFeature = () => {
        if (this.selected && this.ghost) {
            const currIndex = this.getFeatures().indexOf(this.selected);
            this.selected.classList.remove('ghost');
            this.selected = null;
            this.ghost.remove();
            this.ghost = null;

            if (this.initIndex !== currIndex) {
                this.saveSettings();
            }
        }
    }

    /**
     * @param {Boolean} [couldRefresh=true] True to show refresh button
     */
    saveSettings = async (couldRefresh = true) => {
        let features = {
            'default': this.settingsDefault.value
        };
        this.getFeatures().forEach(feature => {
            const id = feature.getAttribute('data-id');
            const isEnabled = !feature.classList.contains('disabled');
            features['f-' + id] = isEnabled; // f to force string, to keep order
        });
        const data = { 'action': 'saveSettings', 'features': features };
        const response = await Request_Async('./user', data);
        if (response.status !== 200 || response.content['status'] !== 'ok') {
            console.log('Response:', response);
            throw new Error('Failed to save settings');
        }

        this.settingsSaved.classList.add('visible');
        if (this.settingsSavedTimeout !== null) {
            clearTimeout(this.settingsSavedTimeout);
        }
        this.settingsSavedTimeout = setTimeout(() => {
            this.settingsSaved.classList.remove('visible');
            this.settingsSavedTimeout = null;
        }, 2 * 1000);

        if (couldRefresh) {
            const refreshLogo = document.getElementById('refresh-logo');
            refreshLogo?.classList.remove('hide');
        }
    }

    async editPassword() {
        this.popup.popup.firstElementChild.classList.add('blur');

        const inputPwdOld = this.popup.inputs.find(input => input.name === 'input-pwd-old') || null;
        const inputPwdNew = this.popup.inputs.find(input => input.name === 'input-pwd-new') || null;
        if (inputPwdOld === null || inputPwdNew === null) throw new Error('No password inputs found');

        const data = { action: 'passwordEdit', passwordOld: inputPwdOld.value, passwordNew: inputPwdNew.value };
        const response = await Request_Async('./user', data);
        const success = response.status === 200 && response.content['status'] === 'ok';

        // Close popup & reset all components
        this.popup.Close();
        await new Promise(resolve => setTimeout(resolve, 200));
        this.popup.popup.firstElementChild.classList.remove('blur');
        inputPwdOld.value = '';
        inputPwdNew.value = '';
        const buttons = Array.from(this.popup.popup.getElementsByTagName('button'));
        const buttonsToggle = buttons.filter(btn => btn.name === 'btn-toggle-pwd');
        buttonsToggle.forEach(btn => {
            const icon = btn.getElementsByTagName('i')[0];
            if (icon.classList.contains('icon-eye-open')) btn.click();
        });

        const text = this.popupMessage.popup.getElementsByTagName('p')[0];
        text.textContent = 'Le mot de passe a été modifié avec succès';
        if (!success) {
            text.textContent = `Le mot de passe n'a pas pu être modifié (${response.status} - ${response.content['status']})`;
        }

        this.popupMessage.Open();
    }
}

new Profile();