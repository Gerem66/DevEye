import { Sleep } from './utils';
import { ffetch } from './request';
import user from './user';

/**
 * @typedef {import('./user').UserType} UserType
 * @typedef {import('./request').RequestResult<UserType>} RequestResult
 */

class Auth {
    /**
     * @private
     */
    __hooks = {
        setLogged: null,
        setShowLogin: null
    };

    /**
     * @private
     */
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

    SetHooks = (setLogged, setShowLogin) => {
        this.__hooks.setLogged = setLogged;
        this.__hooks.setShowLogin = setShowLogin;
    }

    /**
     * @private
     * @returns {boolean}
     */
    checkInputs = () => {
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

    /**
     * @private
     * @param {string} username 
     * @param {string} password 
     * @returns {Promise<RequestResult>}
     */
    loginRequest = async (username, password) => {
        /** @type {RequestInit} */
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

        /** @type {RequestResult} */
        const result = await ffetch('/auth', data);

        return result;
    }

    /**
     * Login to the application
     * @returns {Promise<void>}
     */
    Login = async () => {
        // Check inputs
        if (!this.checkInputs()) {
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
        const data = await this.loginRequest(username, password);

        // Load home page without pause
        if (data.status === 0) {
            if (typeof(this.__hooks.setLogged) === 'function') {
                this.__hooks.setLogged(true);
            }

            // Save user
            user.SetData(data.content);
        }

        // Await for progress bar to finish
        const end = Date.now();
        const elapsed = end - start;
        if (elapsed < 2000) {
            await Sleep(2000 - elapsed);
        }

        if (data.status === 0) {
            this.__input_username.value = '';
            if (typeof(this.__hooks.setShowLogin) === 'function') {
                this.__hooks.setShowLogin(false);
            }

            // Navbar animation
            const navbar = document.getElementById('navbar');
            navbar.classList.add('from-login');

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
        //if (data.status !== 0) {
        //    console.error(data.message);
        //    return;
        //}
    }

    /**
     * Logout from the application
     * @returns {void}
     */
    Logout = () => {
        user.Clear();
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