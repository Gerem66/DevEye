import { Sleep } from '../utils';

const URL = process.env.NODE_ENV === 'production' ? 'https://wyrmo.com/DevEye/Prod/server/auth.php' : 'https://wyrmo.com/DevEye/Dev/server/auth.php';
const LOCAL_USER_KEY = 'user';

class Auth {
    __user = null;

    __hooks = {
        setLogged: null,
        setShowLogin: null
    };

    __requestIsRunning = false;

    onMount = () => {
        this.__card_login = document.getElementById('login-card');
        this.__input_username = /** @type {HTMLInputElement} */ (document.getElementById('tb-username'));
        this.__input_password = /** @type {HTMLInputElement} */ (document.getElementById('tb-password'));

        // Login on press enter
        document.addEventListener('keypress', this.__onKeyPress);
    }

    onUnmount = () => {
        document.removeEventListener('keypress', this.__onKeyPress);
    }

    __onKeyPress = (e) => {
        e.key === 'Enter' && this.Login();
    }

    __setUser = (user) => {
        this.__user = user;
        localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(user));
    }

    GetUser = () => {
        return this.__user;
    }

    __clearUser = () => {
        this.__user = null;
        localStorage.removeItem(LOCAL_USER_KEY);
    }

    SetHooks = (setLogged, setShowLogin) => {
        this.__hooks.setLogged = setLogged;
        this.__hooks.setShowLogin = setShowLogin;
    }

    __checkInputs = () => {
        const username = this.__input_username.value;
        const password = this.__input_password.value;

        // Check inputs
        if (username === '') {
            this.__input_username.focus();
            return false;
        }
        else if (password === '') {
            this.__input_password.focus();
            return false;
        }

        return true;
    }

    __loginRequest = async (username, password) => {
        const data = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                username,
                password
            })
        };

        const result = await fetch(URL, data)
            .then(response => response.json())
            .catch(error => ({
                status: 'error',
                message: 'Erreur de connexion',
                error: error.name + ': ' + error.message
            }));

        return result;
    }

    /**
     * Login to the application
     * @returns {Promise<void>}
     */
    Login = async () => {
        // Check inputs
        if (!this.__checkInputs()) {
            return;
        }

        // Check if request is already running
        if (this.__requestIsRunning) {
            return;
        }
        this.__requestIsRunning = true;

        const username = this.__input_username.value;
        const password = this.__input_password.value;

        // Get start time & start progress bar
        const start = Date.now();
        this.__card_login.classList.add('card-to-progressbar');

        // Login request
        const data = await this.__loginRequest(username, password);

        // Load home page without pause
        if (data['status'] === 'success') {
            if (typeof(this.__hooks.setLogged) === 'function') {
                this.__hooks.setLogged(true);
            }

            // Save user
            this.__setUser(data['user']);
        }

        // Await for progress bar to finish
        const end = Date.now();
        const elapsed = end - start;
        if (elapsed < 2000) {
            await Sleep(2000 - elapsed);
        }

        if (data['status'] === 'success') {
            this.__input_username.value = '';
            if (typeof(this.__hooks.setShowLogin) === 'function') {
                this.__hooks.setShowLogin(false);
            }
            await Sleep(500);
        }

        // Reset login card
        this.__input_password.value = '';
        this.__card_login.classList.remove('card-to-progressbar');

        await Sleep(500);
        this.__input_password.focus();

        // Reset request
        this.__requestIsRunning = false;

        // Error message ?
        //if (data['status'] !== 'success') {
        //    //console.error(data['message']);
        //    return;
        //}
    }

    /**
     * Logout from the application
     * @returns {void}
     */
    Logout = () => {
        this.__clearUser();
        this.__input_username.focus();

        if (typeof(this.__hooks.setLogged) === 'function') {
            this.__hooks.setLogged(false);
        }
        if (typeof(this.__hooks.setShowLogin) === 'function') {
            this.__hooks.setShowLogin(true);
        }
    }
}

const auth = new Auth();

export { Auth };
export default auth;