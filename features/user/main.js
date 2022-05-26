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

        const touch = new MyTouch(this.settingsFeatures);
        touch.AddEventListener('TouchMove', this.onMoveFeature);
        touch.AddEventListener('TouchEnd', this.onDropFeature);
        document.onmouseup = this.onDropFeature;

        // Define default features
        this.settingsDefault.onchange = () => this.saveSettings(false);

        this.settingsSaved = document.getElementById('settings-saved');
        this.settingsSavedTimeout = null;

        // Popups
        this.popup = new Popup('popup-password');
        this.popupMessage = new Popup('popup-message');

        const btnPasswordEdit = document.getElementById('button-password-edit');
        btnPasswordEdit.onclick = () => this.openPopupPassword();

        const img = document.getElementById('image-profile');
        img.onmousedown = (e) => e.preventDefault();
    }
    async onUnmount() {
        clearTimeout(this.settingsSavedTimeout);
    }

    loadFeature = (feature) => {
        const [ dragIcon, eyeIcon ] = feature.getElementsByTagName('span');
        eyeIcon.onclick = () => this.onFeatureToggle(feature, eyeIcon);
        const touch = new MyTouch(dragIcon);
        touch.AddEventListener('TouchStart', (ev) => this.onDragFeature(ev, feature));
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
     * @param {MyTouchEvent} ev
     * @param {HTMLLIElement} feature
     */
    onDragFeature = (ev, feature) => {
        this.initPos.y = feature.offsetTop;
        this.initIndex = this.getFeatures().indexOf(feature);
        this.ghost = feature.cloneNode(true);
        this.ghost.style.width = feature.offsetWidth + 'px';
        this.selected = feature;
        this.selected.classList.add('ghost');
        this.settingsFeatures.appendChild(this.ghost);
        this.onMoveFeature(ev);
        return true;
    }
    /** @param {MyTouchEvent} ev */
    onMoveFeature = (ev) => {
        if (this.ghost) {
            const features = this.getFeatures();
            const currIndex = features.indexOf(this.selected);
            const deltaIndex = this.initIndex - currIndex;
            const height = features[0].offsetHeight;
            const relativeDeltaY = deltaIndex - ev.relativeY / height;
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
            this.ghost.style.top = `${this.initPos.y - ev.relativeY}px`;
        }
        return true;
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

    async openPopupPassword() {
        const [ closeType, inputs ] = await this.popup.Open({ atEnd: 'blur' });
        if (closeType !== 'btn-save') {
            this.popup.Close();
            return;
        }
        const inputPwdOld = inputs.inputs['input-pwd-old'] || null;
        const inputPwdNew = inputs.inputs['input-pwd-new'] || null;
        if (inputPwdOld === null || inputPwdNew === null) {
            throw new Error('No password inputs found');
        }
        await this.editPassword(inputPwdOld, inputPwdNew);
    }

    async editPassword(passwordOld, passwordNew) {
        const data = { action: 'passwordEdit', passwordOld, passwordNew };
        const response = await Request_Async('./user', data);
        const success = response.status === 200 && response.content['status'] === 'ok';

        // Close popup & reset all components
        this.popup.Close();

        const title = success ? 'Succès' : 'Erreur';
        let text = 'Le mot de passe a été modifié avec succès !';
        if (!success) {
            text = `Le mot de passe n'a pas pu être modifié (${response.status} - ${response.content['status']}).`;
        }

        await this.popupMessage.Open({ title, cancelable: false }, (inputs, outputs) => {
            outputs.p['main-text'].textContent = text;
        });
    }
}

new Profile();