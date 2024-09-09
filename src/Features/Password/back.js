import React from 'react';

import { tcp } from '../../Utils/TCP';
import { OpenPopup } from '../../Components/Popup';

/**
 * @typedef {import('Types/Feature').FeatureProps} FeatureProps
 * @typedef {import('Types/Password').PasswordType} PasswordType
 */

/** @type {FeatureProps} */
const FeaturePasswordProps = {
    setUser: () => {},
    //@ts-ignore This variable is necessarily defined
    context: null,
    //@ts-ignore This variable is necessarily defined
    feature: null,

    setContext: () => {},
    setFeature: () => {},
};

class FeaturePasswordBack extends React.Component {
    /** @type {PasswordType[]} All password storage */
    allPasswords = [];

    /** @type {PasswordType[]} Discovered password */
    discovered = [];

    state = {
        loaded: false,

        search: '',

        /** @type {{ [key: string]: PasswordType[] }} Sorted password by categories */
        categories: {},
    }

    /** @type {NodeJS.Timeout[]} */
    timeoutPasswords = [];

    componentDidMount() {
        const { context } = this.props;

        tcp.SendAsync('get-passwords', { contextID: context.id })
            .then(async (response) => {
                if (response === 'timeout') {
                    console.log('Error: Timeout');
                } else if (response === 'not-sended') {
                    console.log('Error: Not sended');
                } else {
                    if (response.status === 0) {
                        this.allPasswords = response.passwords;
                        this.updatePasswords();
                        return;
                    } else {
                        console.log('Error:', response);
                    }
                }
                this.setState({ loaded: true });
            });
    }

    componentWillUnmount() {
        for (const timeout of this.timeoutPasswords) {
            clearTimeout(timeout);
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
                .filter((password) => password.category.toLowerCase() === category.toLowerCase())
                .filter((password) => password.service.toLowerCase().includes(search.toLowerCase()))
                .sort((a, b) => a.service.localeCompare(b.service))
                .sort((a, b) => a.status === b.status ? 0 : a.status === 'active' ? -1 : 1)
                .map((password) => this.discovered.find((p) => p.ID === password.ID) || password)
            }))
            .reduce((acc, cur) => ({ ...acc, ...cur }), {});

        this.setState({ loaded: true, categories, search });
    }

    /** @param {React.ChangeEvent<HTMLInputElement>} e */
    onSearchChange = (e) => {
        this.updatePasswords(e.target.value);
    }

    /** @param {number} ID */
    GetPassword = async (ID) => {
        const { context } = this.props;

        const response = await tcp.SendAsync('get-password', {
            contextID: context.id,
            passwordID: ID
        });
        if (response === 'timeout') {
            console.log('Error: Timeout');
            return;
        } else if (response === 'not-sended') {
            console.log('Error: Not sended');
            return;
        } else if (response.status === 2) {
            const a = await OpenPopup('popup-unlock');
            if (a !== null) {
                this.GetPassword(ID);
            }
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

    /** @param {number | null} ID */
    OpenEditPassword = async (ID) => {
        const { context } = this.props;

        /** @type {PasswordType} */
        let password = {
            ID: 0,
            category: '',
            service: '',
            email: '',
            password: '',
            status: 'active'
        };

        if (ID !== null) {
            const response = await tcp.SendAsync('get-password', {
                contextID: context.id,
                passwordID: ID
            });
            if (response === 'timeout') {
                console.log('Error: Timeout');
                return;
            } else if (response === 'not-sended') {
                console.log('Error: Not sended');
                return;
            } else if (response.status === 2) {
                const a = await OpenPopup('popup-unlock');
                if (a !== null) {
                    this.OpenEditPassword(ID);
                }
                return;
            } else if (response.status !== 0 || response.password === null) {
                console.log('Error:', response);
                return
            }
            password = response.password;
        }

        /** @type {Promise<'delete' | PasswordType | null>} */
        const popup = OpenPopup('popup-add-password', password);

        popup.then(async (newPassword) => {
            if (newPassword === null) {
                return;
            }

            // Remove password
            if (newPassword === 'delete') {
                if (ID !== null) {
                    const response = await tcp.SendAsync('delete-password', {
                        contextID: context.id,
                        passwordID: ID
                    });
                    if (response === 'timeout' || response === 'not-sended' || response.status !== 0) {
                        console.log('Error:', response);
                        return;
                    }
                    this.allPasswords = this.allPasswords.filter((p) => p.ID !== ID);
                }
            }

            // Add password
            else if (ID === null) {
                const response = await tcp.SendAsync('add-password', {
                    contextID: context.id,
                    password: newPassword
                });
                if (response === 'timeout' || response === 'not-sended' || response.status !== 0 || response.password === null) {
                    console.log('Error:', response);
                    return;
                }
                this.allPasswords.push(response.password);
            }

            // Edit password
            else {
                const response = await tcp.SendAsync('edit-password', {
                    contextID: context.id,
                    password: newPassword
                });
                if (response === 'timeout' || response === 'not-sended' || response.status !== 0 || response.password === null) {
                    console.log('Error:', response);
                    return;
                }
                const index = this.allPasswords.findIndex((p) => p.ID === ID);
                if (index !== -1) {
                    this.allPasswords[index] = response.password;
                }
            }

            this.updatePasswords();
        });
    }
}

FeaturePasswordBack.defaultProps = FeaturePasswordProps;
FeaturePasswordBack.prototype.props = FeaturePasswordProps;

export default FeaturePasswordBack;
