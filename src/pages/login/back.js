import React from 'react';

import { DefaultUser } from '../../Types/User';
import { GlobalContext } from '../../context';
import { ffetch } from '../../Utils/request';
import { Sleep } from '../../Utils/functions';

/**
 * @typedef {import('../../context').ReactContextType} ContextType
 */

const LoginPageProps = {
};

/** @extends {React.Component<{}, {}, ContextType>} */
class LoginPageBack extends React.Component {
    static contextType = GlobalContext;

    state = {
        show: true,
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

    startTimeLoading = 0;

    componentDidMount() {
        const { user } = /** @type {ContextType} */ (this.context);
        if (user !== null) {
            this.LoginFromToken(user.Token);
        }
    }

    componentDidUpdate() {
        const { user } = /** @type {ContextType} */ (this.context);
        const newState = user === null;

        /*
        if (newState !== this.state.show) {
            this.setState({ show: newState });
            if (newState) {
                this.inputUsername.current.focus();
            }
        }
        */
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

    StartAnimation = () => {
        this.startTimeLoading = Date.now();
        this.cardLogin.current.classList.add('card-to-progressbar');
    }

    WaitAnimation = async () => {
        const end = Date.now();
        const elapsed = end - this.startTimeLoading;
        if (elapsed < 2000) {
            await Sleep(2000 - elapsed);
        }
    }

    StopAnimation = () => {
        this.cardLogin.current.classList.remove('card-to-progressbar');
    }

    onLogin = async () => {
        const { server, setUser } = /** @type {ContextType} */ (this.context);
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

        this.StartAnimation();

        // Login request
        const data = await ffetch('auth', { username, password });
        const newUser = { ...DefaultUser, Token: data.content };
        await Sleep(200);

        const response = await server.SendAndWaitForCallback('get-user-info', {
            token: data.content
        })
        console.log(response);

        await this.WaitAnimation();

        // Open home page
        if (data.status === 0) {
            this.setState({
                input: {
                    username: '',
                    password: ''
                }
            });

            // Set user
            setUser(newUser);
            this.setState({ show: false });

            // Await for navbar animation to finish
            await Sleep(500);
        }

        // Reset text inputs
        else {
            this.setState({ input: { username, password: '' } });
            this.inputPassword.current.focus();
        }

        this.StopAnimation();
    }

    /**
     * @param {string} token
     */
    LoginFromToken = async (token) => {
        // Login request
        const { server, user, setUser } = /** @type {ContextType} */ (this.context);

        this.StartAnimation();

        // Login request
        const data = await ffetch('auto-login', { token: user.Token });
        if (data.status !== 0) {
            // Invalid token, reset user
            setUser(null);

            await this.WaitAnimation();
            this.StopAnimation();
            return;
        }

        const newUser = { ...DefaultUser, Token: data.content };
        await Sleep(200);

        const response = await server.SendAndWaitForCallback('get-user-info', {
            token: data.content
        })
        console.log(response);

        await this.WaitAnimation();

        // Open home page
        if (data.status === 0) {
            // Set user
            //setUser(newUser);
            this.setState({ show: false });
            await Sleep(500);
        }

        // Reset text inputs
        else {
        }

        this.StopAnimation();
    }
}

LoginPageBack.defaultProps = LoginPageProps;
LoginPageBack.prototype.props = LoginPageProps;

export default LoginPageBack;
