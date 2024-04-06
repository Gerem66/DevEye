import React from 'react';

import { DefaultUser } from '../../Types/User';
import { tcp } from '../../Utils/TCP';
import { ffetch } from '../../Utils/Request';
import { Sleep } from '../../Utils/Functions';
import { Clear, Load, Save } from '../../Utils/Storage';

/**
 * @typedef {import('Types/User').UserType} UserType
 */

const LoginPageProps = {
    /** @type {UserType | null} */
    user: null,

    /** @type {(user: UserType | null) => void} */
    setUser: (user) => {}
};

class LoginPageBack extends React.Component {
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
        const token = Load('token');
        if (token !== null && typeof token === 'string') {
            this.LoginFromToken(token);
        }
    }

    componentDidUpdate() {
        // Disconnect user
        if (this.props.user === null && this.state.show === false) {
            this.setState({ show: true });
            Clear('token');
        }
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

    StartAnimation = (autoLogin = false) => {
        this.startTimeLoading = Date.now();
        this.cardLogin.current?.classList.add('card-to-progressbar');
        if (autoLogin) {
            this.cardLogin.current?.classList.add('auto-login');
        }
    }

    WaitAnimation = async () => {
        const end = Date.now();
        const elapsed = end - this.startTimeLoading;
        if (elapsed < 2000) {
            await Sleep(2000 - elapsed);
        }
    }

    StopAnimation = () => {
        this.startTimeLoading = 0;
        this.cardLogin.current?.classList.remove('card-to-progressbar');
        this.cardLogin.current?.classList.remove('auto-login');
    }

    onLogin = async () => {
        const { setUser } = this.props;
        const { input: { username, password } } = this.state;

        if (tcp === null || this.startTimeLoading !== 0) {
            return;
        }

        // Check inputs
        if (username === '') {
            this.inputUsername.current?.focus();
            return;
        }
        else if (password === '') {
            this.inputPassword.current?.focus();
            return;
        }

        this.inputUsername.current?.blur();
        this.inputPassword.current?.blur();

        this.StartAnimation();

        // Login request
        const data = await ffetch('auth', { username, password });

        let newUser = DefaultUser;

        let connected = false;
        if (data.status === 0) {
            connected = await tcp.Connect(() => setUser(null));
            if (connected) {
                const response = await tcp.SendAsync('login', {
                    token: data.content,
                    password: password
                });

                if (response === 'not-sended' || response === 'timeout' || response.status !== 0) {
                    connected = false;
                    tcp.Disconnect();
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
            Save('token', newUser.Token);
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
        const { setUser } = this.props;
        if (tcp === null) {
            return;
        }

        this.StartAnimation(true);

        // Login request
        const data = await ffetch('check-token', { token });
        if (data.status !== 0) {
            // Invalid token, reset user
            Clear('token');

            await this.WaitAnimation();
            this.StopAnimation();
            return;
        }

        let connected = await tcp.Connect(() => setUser(null));
        if (connected === false) {
            Clear('token');
            await this.WaitAnimation();
            this.StopAnimation();
            return;
        }

        const response = await tcp.SendAsync('login', { token, password: null });

        if (response === 'not-sended' || response === 'timeout' || response.status !== 0) {
            connected = false;
            tcp.Disconnect();
            Clear('token');
            await this.WaitAnimation();
            this.StopAnimation();
            return;
        }

        await this.WaitAnimation();

        setUser({
            ...DefaultUser,
            ...response.user,
            Token: token
        });

        // Open home page
        this.setState({ show: false });

        // Wait for home animation to finish
        await Sleep(500);
        this.StopAnimation();
    }
}

LoginPageBack.defaultProps = LoginPageProps;
LoginPageBack.prototype.props = LoginPageProps;

export default LoginPageBack;
