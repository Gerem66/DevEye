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
            features[id] = isEnabled;
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
}

new Profile();

/*
function Init_User() {
    let bt_show_passwords = document.getElementsByName('bt-show-password');
    for (let i = 0; i < bt_show_passwords.length; i++) {
        bt_show_passwords[i].onclick = () => SwitchPasswordVision(bt_show_passwords[i]);
    }

    let bt_open_changepwd = document.getElementById('bt-open-changepwd');
    let bt_open_quicklink = document.getElementById('bt-open-quicklink');
    bt_open_changepwd.onclick = OpenChangepasswordPopup;
}

function OpenChangepasswordPopup() {
    let popup = document.getElementById('popup-changepwd');
    popup.classList.add('active');

    let tb_password = document.getElementsByName('pwd')[0];
    let tb_new_password = document.getElementsByName('new-pwd')[0];
    let btn_save = document.getElementsByName('save')[0];
    let btn_back = document.getElementsByName('back')[0];
    tb_password.focus();

    function SavePassword() {
        btn_save.disabled = true;
        let password = tb_password.value;
        let new_password = tb_new_password.value;

        // Get quicklink
        let data = new FormData();
        data.append('changepassword', password);
        data.append('newpassword', new_password);
        params = { method: 'POST', body: data };
        fetch('./user', params)
            .then(function(res) { return res.text(); })
            .then(function(content) {
                if (content === "OK") {
                    tb_password.parentNode.parentNode.innerHTML = "<p>Mot de passe modifié avec succès !</p>";
                } else if (content == "WRONG") {
                    tb_password.parentNode.parentNode.innerHTML = "<p>Une erreur est survenue. (Wrong password)</p>";
                } else {
                    tb_password.parentNode.parentNode.innerHTML = "<p>Une erreur est survenue. (" + content + ")</p>";
                }
            })
            .catch(function(err) {
                tb_password.parentNode.parentNode.innerHTML = "<p>Une erreur est survenue. (" + err + ")</p>";
            })
            .finally(function() {
                btn_save.remove();
                tb_new_password.parentNode.parentNode.remove();
                btn_back.onclick = () => LoadPage('user');
                popup.onclick = (e) => { if (e.target === popup) LoadPage('user'); }
            });
    }

    btn_save.onclick = SavePassword;
    btn_back.onclick = () => popup.classList.remove('active');
    popup.onclick = (e) => { if (e.target === popup) popup.classList.remove('active'); }
}
*/