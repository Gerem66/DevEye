import React from 'react';

import { tcp } from '../../Utils/TCP';
import { DefaultUser } from '../../Types/User';
import { OpenPopup } from '../../Components/Popup';

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
        tmpPassword: '',

        search: '',

        /** @type {{ [key: string]: PasswordType[] }} Sorted password by categories */
        categories: {},
    }

    /** @type {NodeJS.Timeout | null} */
    timeout = null;

    componentDidMount() {
        const { user } = this.props;

        tcp.SendAsync('get-passwords', { userID: user.ID })
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
        if (this.timeout !== null) {
            clearTimeout(this.timeout);
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
                .map((password) => this.discovered.find((p) => p.ID === password.ID) || password)
            }))
            .reduce((acc, cur) => ({ ...acc, ...cur }), {});

        this.setState({ categories, search });
    }

    /** @param {React.ChangeEvent<HTMLInputElement>} e */
    onSearchChange = (e) => {
        this.updatePasswords(e.target.value);
    }

    /** @param {number} ID */
    GetPassword = async (ID) => {
        const { user } = this.props;
        const { locked, tmpPassword } = this.state;

        if (locked) {
            await new Promise((resolve) => {
                OpenPopup('popup-unlock', () => {
                    resolve(null);
                })
            });
        }

        const response = await tcp.SendAsync('get-password', { userID: user.ID, passwordID: ID });
        if (response === 'timeout') {
            console.log('Error: Timeout');
            return;
        } else if (response === 'not-sended') {
            console.log('Error: Not sended');
            return;
        } else if (response.status !== 0) {
            console.log('Error:', response);
            return
        }

        this.timeout = setTimeout(() => {
            this.ResetPassword(response.password.ID);
        }, 5000);

        this.discovered.push(response.password);
        this.updatePasswords();
    }

    /** @param {number} ID */
    ResetPassword = (ID) => {
        this.discovered = this.discovered.filter((password) => password.ID !== ID);
        this.updatePasswords();
    }
}

FeaturePasswordBack.defaultProps = FeaturePasswordProps;
FeaturePasswordBack.prototype.props = FeaturePasswordProps;

export default FeaturePasswordBack;
