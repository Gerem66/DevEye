import React from 'react';

import { DefaultUser } from '../../Types/User';
import { GlobalContext } from '../../context';
import { ffetch } from '../../Utils/request';
import { Sleep } from '../../Utils/functions';

/**
 * @typedef {import('../../Types/User').UserType} UserType
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

    /** @param {React.KeyboardEvent<HTMLDivElement>} e */
    onKeyDown = (e) => {
        if (e.key === 'Enter') {
            this.onLogin();
        }
    }

    StartAnimation = () => {
        this.startTimeLoading = Date.now();
        this.cardLogin.current?.classList.add('card-to-progressbar');
    }

    WaitAnimation = async () => {
        const end = Date.now();
        const elapsed = end - this.startTimeLoading;
        if (elapsed < 2000) {
            await Sleep(2000 - elapsed);
        }
    }

    StopAnimation = () => {
        this.cardLogin.current?.classList.remove('card-to-progressbar');
    }

    onLogin = async () => {
        const { server, setUser } = /** @type {ContextType} */ (this.context);
        const { input: { username, password } } = this.state;

        // Check inputs
        if (username === '') {
            this.inputUsername.current?.focus();
            return;
        }
        else if (password === '') {
            this.inputPassword.current?.focus();
            return;
        }

        this.StartAnimation();

        // Login request
        const data = await ffetch('auth', { username, password });

        let newUser = DefaultUser;

        let connected = false;
        if (data.status === 0) {
            connected = await server.Connect();
            if (connected) {
                const response = await server.SendAndWaitForCallback('get-user-info', {
                    token: data.content
                });

                if (response === 'not-sended' || response === 'timeout' || response.status !== 0) {
                    connected = false;
                    server.Disconnect();
                } else {
                    // Response.user into newUser
                    newUser = {
                        ...newUser,
                        ...response.user,
                        Token: data.content
                    };
                }
            }
        }

        await this.WaitAnimation();

        // Open home page
        if (data.status === 0 && connected) {
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
            this.inputPassword.current?.focus();
        }

        this.StopAnimation();
    }

    /**
     * @param {string} token
     */
    LoginFromToken = async (token) => {
        // Login request
        const { server, user, setUser } = /** @type {ContextType} */ (this.context);
        if (user === null) {
            return;
        }

        this.StartAnimation();

        // Login request
        const data = await ffetch('check-token', { token: user.Token });
        if (data.status !== 0) {
            // Invalid token, reset user
            setUser(null);

            await this.WaitAnimation();
            this.StopAnimation();
            return;
        }

        let connected = await server.Connect();
        if (connected === false) {
            setUser(null);
            await this.WaitAnimation();
            this.StopAnimation();
            return;
        }

        const response = await server.SendAndWaitForCallback('get-user-info', {
            token: user.Token
        });

        if (response === 'not-sended' || response === 'timeout' || response.status !== 0) {
            connected = false;
            server.Disconnect();
            setUser(null);
            await this.WaitAnimation();
            this.StopAnimation();
            return;
        }

        // Response.user into newUser
        /** @type {UserType} */
        const newUser = {
            ...user,
            ...response.user
        };

        await this.WaitAnimation();

        // Open home page
        setUser(newUser);
        this.setState({ show: false });

        this.StopAnimation();
    }
}

LoginPageBack.defaultProps = LoginPageProps;
LoginPageBack.prototype.props = LoginPageProps;

export default LoginPageBack;
