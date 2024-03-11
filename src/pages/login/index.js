import React from 'react';

import './style.css';
import './input.css';
import { DefaultUser } from '../../Types/User';
import { GlobalContext } from '../../context';
import { ffetch } from '../../class/request';
import { Sleep } from '../../Utils/functions';

/**
 * @typedef {import('../../context').ReactContextType} ContextType
 * @typedef {import('Types/User').UserType} UserType
 * @typedef {import('../../class/request').RequestResult<UserType>} RequestResult
 */

const LoginPageProps = {
};

// TODO: Handle enter key press

/** @extends {React.Component<{}, {}, ContextType>} */
class LoginPage extends React.Component {
    static contextType = GlobalContext;

    state = {
        show: false,
        input: {
            username: '',
            password: ''
        }
    };

    /** @type {React.RefObject<HTMLDivElement>} */
    cardLogin = React.createRef();

    /** @type {React.RefObject<HTMLInputElement>} */
    inputUsername = React.createRef();

    /** @type {React.RefObject<HTMLInputElement>} */
    inputPassword = React.createRef();

    componentDidMount() {
        const { user } = /** @type {ContextType} */ (this.context);
        if (user === null) {
            this.setState({ show: true });
        }
    }

    componentDidUpdate() {
        const { user } = /** @type {ContextType} */ (this.context);
        const newState = user === null;

        if (newState !== this.state.show) {
            this.setState({ show: newState });
            if (newState) {
                this.inputUsername.current.focus();
            }
        }
    }

    componentWillUnmount() {
    }

    /** @param {React.ChangeEvent<HTMLInputElement>} e */
    onInputUsernameChange = (e) => {
        this.setState({ input: { ...this.state.input, username: e.target.value } });
    }

    /** @param {React.ChangeEvent<HTMLInputElement>} e */
    onInputPasswordChange = (e) => {
        this.setState({ input: { ...this.state.input, password: e.target.value } });
    }

    onKeyDown = (e) => {
        if (e.key === 'Enter') {
            this.onLogin();
        }
    }

    onLogin = async () => {
        const { setUser } = /** @type {ContextType} */ (this.context);
        const { input: { username, password } } = this.state;

        // Check inputs
        if (username === '') {
            this.inputUsername.current.focus();
            return;
        }
        else if (password === '') {
            this.inputPassword.current.focus();
            return;
        }

        // Prepare animation
        const start = Date.now();
        this.cardLogin.current.classList.add('card-to-progressbar');

        // Login request
        const data = await this.loginRequest(username, password);

        // Await for progress bar animation to finish
        const end = Date.now();
        const elapsed = end - start;
        if (elapsed < 2000) {
            await Sleep(2000 - elapsed);
        }

        // Open home page
        if (data.status === 0) {
            this.inputUsername.current.value = '';
            this.inputPassword.current.value = '';

            // Await for navbar animation to finish
            await Sleep(500);

            // Set user
            this.setState({ show: false });
            setUser({ ...DefaultUser, ...data.content });
        }

        // Reset text inputs
        else {
            this.inputPassword.current.value = '';
            this.inputPassword.current.focus();
        }

        // Reset animation
        await Sleep(200);
        this.cardLogin.current.classList.remove('card-to-progressbar');
    }

    /**
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

    render() {
        return (
            <div className={'login' + (this.state.show ? ' show' : '')}>
                <div className='form'>

                    {/* Title */}
                    <span className='title'>
                        <b>Dev</b> <p>Eye</p>
                    </span>

                    <div
                        ref={this.cardLogin}
                        className='login-card'
                        onKeyDown={this.onKeyDown}
                    >
                        {/* Progress bar */}
                        <div className='progress-bar' />

                        {/* Username input */}
                        <div className='input-group'>
                            <input
                                ref={this.inputUsername}
                                className='form-input'
                                type='text'
                                placeholder="Nom d'utilisateur"
                                content={this.state.input.username}
                                onChange={this.onInputUsernameChange}
                                autoFocus
                            />
                            <span className='icon icon-user'></span>
                        </div>

                        {/* Password input */}
                        <div className='input-group'>
                            <input
                                ref={this.inputPassword}
                                className='form-input'
                                type='password'
                                placeholder='Mot de passe'
                                content={this.state.input.password}
                                onChange={this.onInputPasswordChange}
                            />
                            <span className='icon icon-lock' />
                        </div>

                        {/* Submit button */}
                        <button
                            className='submit'
                            onClick={this.onLogin}
                        >
                            Se connecter
                        </button>
                    </div>
                </div>

            </div>
        );
    }
}

LoginPage.defaultProps = LoginPageProps;
LoginPage.prototype.props = LoginPageProps;

export default LoginPage;
