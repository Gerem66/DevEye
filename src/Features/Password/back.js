import React from 'react';

import { tcp } from '../../Utils/TCP';
import { DefaultUser } from '../../Types/User';
import { ClosePopup, OpenPopup } from '../../Components/Popup';

/**
 * @typedef {import('Types/Feature').FeatureProps} FeatureProps
 * @typedef {import('Types/Password').PasswordType} PasswordType
 */

/** @type {FeatureProps} */
const FeaturePasswordProps = {
    user: DefaultUser,
    setUser: () => {},
    //@ts-ignore This variable is necessarily defined
    context: null,
    //@ts-ignore This variable is necessarily defined
    feature: null
};

class FeaturePasswordBack extends React.Component {
    /** @type {PasswordType[]} All password storage */
    allPasswords = [];

    /** @type {PasswordType[]} Discovered password */
    discovered = [];

    state = {
        /** @type {boolean} Show popup to ask password or not */
        locked: true,
        inputPassword: '',
        tmpPassword: '',

        search: '',

        /** @type {{ [key: string]: PasswordType[] }} Sorted password by categories */
        categories: {},
    }

    /** @type {NodeJS.Timeout[]} */
    timeoutPasswords = [];

    /** @type {NodeJS.Timeout | null} */
    timeoutUnlock = null;

    componentDidMount() {
        const { user, context } = this.props;

        tcp.SendAsync('get-passwords', { contextID: context.id, userID: user.ID })
            .then(async (response) => {
                if (response === 'timeout') {
                    console.log('Error: Timeout');
                } else if (response === 'not-sended') {
                    console.log('Error: Not sended');
                } else {
                    if (response.status === 0) {
                        this.allPasswords = response.passwords;
                        this.updatePasswords();
                    } else {
                        console.log('Error:', response);
                    }
                }
            });
    }

    componentWillUnmount() {
        for (const timeout of this.timeoutPasswords) {
            clearTimeout(timeout);
        }
        if (this.timeoutUnlock !== null) {
            clearTimeout(this.timeoutUnlock);
        }
    }

    /** @param {string} [search] */
    updatePasswords = (search = this.state.search) => {
        const categories = this.allPasswords
            .map((password) => password.category)
            .filter((value, index, self) => self.indexOf(value) === index)
            .map((category) => category.charAt(0).toUpperCase() + category.slice(1))
            .sort()
            .map((category) => ({ [category]: this.allPasswords
                .filter((password) => password.category === category)
                .filter((password) => password.service.toLowerCase().includes(search.toLowerCase()))
                .sort((a, b) => a.service.localeCompare(b.service))
                .sort((a, b) => a.status === b.status ? 0 : a.status === 'active' ? -1 : 1)
                .map((password) => this.discovered.find((p) => p.ID === password.ID) || password)
            }))
            .reduce((acc, cur) => ({ ...acc, ...cur }), {});

        this.setState({ categories, search });
    }

    /** @param {React.ChangeEvent<HTMLInputElement>} e */
    onSearchChange = (e) => {
        this.updatePasswords(e.target.value);
    }

    Lock = () => {
        if (this.timeoutUnlock !== null) {
            clearTimeout(this.timeoutUnlock);
            this.timeoutUnlock = null;
        }
        this.setState({ locked: true, tmpPassword: '' });
    }

    Unlock = async () => {
        if (!this.state.locked && this.state.tmpPassword !== '') {
            if (this.timeoutUnlock !== null) {
                clearTimeout(this.timeoutUnlock);
            }
            this.timeoutUnlock = setTimeout(this.Lock, 30000);
            return true;
        }

        if (this.state.locked) {
            await new Promise((resolve) => {
                OpenPopup('popup-unlock', () => {
                    resolve(null);
                })
            });
            this.setState({ inputPassword: '' });
            if (this.state.locked) {
                return false;
            }
        }

        this.timeoutUnlock = setTimeout(this.Lock, 30000);
        return true;
    }

    /** @param {number} ID */
    GetPassword = async (ID) => {
        const { user, context } = this.props;

        const unlocked = await this.Unlock();
        if (!unlocked) {
            return;
        }

        const { tmpPassword } = this.state;
        const response = await tcp.SendAsync('get-password', {
            contextID: context.id,
            userID: user.ID,
            passwordID: ID,
            password: tmpPassword
        });
        if (response === 'timeout') {
            console.log('Error: Timeout');
            return;
        } else if (response === 'not-sended') {
            console.log('Error: Not sended');
            return;
        } else if (response.status !== 0 || response.password === null) {
            console.log('Error:', response);
            return
        }

        this.timeoutPasswords.push(setTimeout(() => {
            if (response.password !== null) {
                this.ResetPassword(response.password.ID);
            }
        }, 5000));

        this.discovered.push(response.password);
        this.updatePasswords();
    }

    /** @param {number} ID */
    ResetPassword = (ID) => {
        this.discovered = this.discovered.filter((password) => password.ID !== ID);
        this.updatePasswords();
    }

    /** Unlock popup */

    /** @param {React.ChangeEvent<HTMLInputElement>} e */
    onInputPasswordChange = (e) => {
        this.setState({ inputPassword: e.target.value });
    }

    UnlockPassword = async () => {
        const { inputPassword } = this.state;
        const { user, context } = this.props;

        const response = await tcp.SendAsync('check-password', {
            contextID: context.id,
            userID: user.ID,
            password: inputPassword
        });

        if (response === 'timeout') {
            console.log('Error: Timeout');
            return;
        } else if (response === 'not-sended') {
            console.log('Error: Not sended');
            return;
        } else if (response.status !== 0) {
            console.log('Error:', response);
            return;
        }

        this.setState({ locked: false, tmpPassword: inputPassword }, () => {
            ClosePopup('popup-unlock');
        });
    }
}

FeaturePasswordBack.defaultProps = FeaturePasswordProps;
FeaturePasswordBack.prototype.props = FeaturePasswordProps;

export default FeaturePasswordBack;
