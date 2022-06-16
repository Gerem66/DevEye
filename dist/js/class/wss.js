/**
 * @typedef {Object} WssResponse
 * @property {void} normal
 * @property {Promise<MessageEvent|null>} waitResponse
 */

class WSS {
    headerStyle = false;
    headerScript = false;

    constructor() {
        this.socket = null;
    }

    async Connect() {
        const IP = '45.82.73.154';
        const PORT = '8080';
        const socket = new WebSocket(`wss://${IP}:${PORT}`);

        const connected = await new Promise((resolve) => {
            setTimeout(() => resolve(false), 2000);
            socket.onopen = () => resolve(true);
            socket.onerror = () => resolve(false);
        });

        if (!connected) {
            socket.onopen = this.Disconnect.bind(this);
            return false;
        }

        this.socket = socket;
        this.resetEvents();

        return true;
    }

    async UserConnection(username, password) {
        const reqIP = await fetch('https://wyrmo.com/DevEye/dist/gettoken.php');
        const IP = await reqIP.text();
        const data = { type: 'connect', username, password, IP };
        const response = await this.sendData(data, 'waitResponse');
        return response.data;
    }

    UserDisconnection() {
        if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
            return;
        }
        const data = { type: 'disconnect' };
        this.sendData(data, 'normal');
    }

    Disconnect() {
        if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
            this.sendData('exit', 'normal');
        }
    }

    resetEvents() {
        this.socket.onmessage = this.onMessage.bind(this);
        this.socket.onerror = this.onError.bind(this);
        this.socket.onclose = this.onDisconnect.bind(this);
    }

    /** @param {Event} error */
    onError(error) {
        //throw new Error('Server.Error:', error);
        deveye.login.loginContent.classList.remove('form-hide');
    }

    onDisconnect() {
        deveye.ShowErrorMessage('Une erreur est survenue');
    }

    /**
     * @template {keyof WssResponse} T
     * @param {string|object} data Send data to server
     * @param {T} type
     * @param {number} [timeout=5000] Timeout in ms (default: 5000, only for waitResponse)
     * @returns {WssResponse[T]} If type is 'waitResponse' return response,\
     * If type is 'waitResponse' but failed, returns null,\
     * If type is 'normal': void
     */
    async sendData(data, type = 'normal', timeout = 5000) {
        if (this.socket === null) {
            throw new Error('Server.sendData: socket is null');
        }

        if (typeof(data) === "object") {
            data = JSON.stringify(data);
        }

        this.socket.send(data);
        if (!type) return;

        const response = await new Promise((resolve) => {
            const _timeout = setTimeout(() => resolve(null), timeout);
            this.socket.onmessage = (event) => {
                clearTimeout(_timeout);
                resolve(event || null);
            }
        });

        this.resetEvents();
        return response;
    }

    async onMessage(message) {
        if (!message?.data || !StrIsJson(message.data)) {
            return false;
        }

        const data = JSON.parse(message.data);
        if (!data.hasOwnProperty('type')) {
            return false;
        }

        switch (data.type) {
            case 'page':
                deveye.SetContent(data.page, data.category, data.data);
                break;
        }
    }

    async LoadData() {
        deveye.login.loginForm.classList.add('form-hide');

        if (this.headerScript === false) {
            this.headerScript = true;
            deveye.login.loadingSetState(30, 'Téléchargement des scripts...');
            const dataScripts = { type: 'loadScripts' };
            const responseScripts = await this.sendData(dataScripts, 'waitResponse');
            const scripts = responseScripts.data;

            deveye.login.loadingSetState(50, 'Chargement des scripts...');
            const script = document.createElement('script');
            script.textContent = scripts;
            document.head.appendChild(script);
            document.head.removeChild(script);
        }

        if (this.headerStyle === false) {
            this.headerStyle = true;
            deveye.login.loadingSetState(60, 'Téléchargement des styles...');
            const dataStyles = { type: 'loadStyles' };
            const responseStyles = await this.sendData(dataStyles, 'waitResponse');
            const styles = responseStyles.data;

            deveye.login.loadingSetState(80, 'Chargement des styles...');
            const style = document.createElement('style');
            style.innerHTML = styles;
            document.head.appendChild(style);
        }

        deveye.login.loadingSetState(90, 'Rendu des composants...');
        const dataBody = { type: 'loadBody' };
        const responseBody = await this.sendData(dataBody, 'waitResponse');
        const home = document.createElement('div');
        home.innerHTML = responseBody.data;
        document.body.insertBefore(home, document.body.firstChild);

        const homebar = document.getElementById('homebar');
        homebar.onclick = () => deveye.Load('user');

        deveye.login.loadingSetState(100, 'Terminé');
        await new Promise((resolve) => setTimeout(resolve, 100));
        deveye.login.loadingSetState(-1);
    }

    /**
     * @param {Pages} pageName
     * @param {String} category
     */
    async GetPage(pageName, category = null) {
        const reqData = {
            type: 'loadPage',
            page: pageName,
            category: category
        };
        const response = await this.sendData(reqData, 'waitResponse');
        return response?.data || null;
    }
}