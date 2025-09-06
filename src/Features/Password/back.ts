import React from 'react';

import { tcp } from '@/Utils/TCP';
import { OpenPopup } from '@/Components/Popup';

import type { FeatureProps, PasswordType } from 'deveye-types';

class FeaturePasswordBack extends React.Component<FeatureProps> {
    /** All password storage */
    allPasswords: PasswordType[] = [];

    /** Discovered password */
    discovered: PasswordType[] = [];

    state = {
        loaded: false,

        search: '',

        /** Sorted password by categories */
        categories: {} as { [key: string]: PasswordType[] }
    };

    timeoutPasswords: NodeJS.Timeout[] = [];

    componentDidMount() {
        this.loadPasswords();
    }

    componentWillUnmount() {
        for (const timeout of this.timeoutPasswords) {
            clearTimeout(timeout);
        }
    }

    loadPasswords = async () => {
        const { workspace } = this.props;

        const response = await tcp.SendAndWait('get-passwords', { workspaceID: workspace.id });

        this.setState({ loaded: true });

        if (response === 'timeout' || response === 'not-sended') {
            console.warn('Error: Could not load passwords');
            return;
        }

        if (response.status !== 'success') {
            console.error('Error:', response);
            return;
        }

        this.allPasswords = response.passwords;
        this.UpdatePasswords();
    };

    onSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        this.UpdatePasswords(e.target.value);
    };

    UpdatePasswords = (search: string = this.state.search) => {
        const categories = this.allPasswords
            .map((password) => password.category)
            .filter((value, index, self) => self.indexOf(value) === index)
            .map((category) => category.charAt(0).toUpperCase() + category.slice(1))
            .sort()
            .map((category) => ({
                [category]: this.allPasswords
                    .filter((password) => password.category.toLowerCase() === category.toLowerCase())
                    .filter((password) => password.service.toLowerCase().includes(search.toLowerCase()))
                    .sort((a, b) => a.service.localeCompare(b.service))
                    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1))
                    .map((password) => this.discovered.find((p) => p.ID === password.ID) || password)
            }))
            .reduce((acc, cur) => ({ ...acc, ...cur }), {});

        this.setState({ loaded: true, categories, search });
    };

    GetPassword = async (ID: number) => {
        const { workspace } = this.props;

        const response = await tcp.SendAndWait('get-password', {
            workspaceID: workspace.id,
            passwordID: ID
        });
        if (response === 'timeout') {
            console.log('Error: Timeout');
            return;
        } else if (response === 'not-sended') {
            console.log('Error: Not sended');
            return;
        } else if (response.status === 'unlock-failed') {
            const a = await OpenPopup('popup-unlock');
            if (a !== null) {
                this.GetPassword(ID);
            }
            return;
        } else if (response.status !== 'success') {
            console.log('Error:', response);
            return;
        }

        this.timeoutPasswords.push(
            setTimeout(() => {
                if (response.password !== null) {
                    this.ResetPassword(response.password.ID);
                }
            }, 5000)
        );

        this.discovered.push(response.password);
        this.UpdatePasswords();
    };

    ResetPassword = (ID: number) => {
        this.discovered = this.discovered.filter((password) => password.ID !== ID);
        this.UpdatePasswords();
    };

    OpenEditPassword = async (ID: number | null) => {
        const { workspace } = this.props;

        let password: PasswordType = {
            ID: 0,
            category: '',
            service: '',
            email: '',
            password: '',
            status: 'active'
        };

        if (ID !== null) {
            const response = await tcp.SendAndWait('get-password', {
                workspaceID: workspace.id,
                passwordID: ID
            });
            if (response === 'timeout') {
                console.log('Error: Timeout');
                return;
            } else if (response === 'not-sended') {
                console.log('Error: Not sended');
                return;
            } else if (response.status === 'unlock-failed') {
                const a = await OpenPopup('popup-unlock');
                if (a !== null) {
                    this.OpenEditPassword(ID);
                }
                return;
            } else if (response.status !== 'success') {
                console.log('Error:', response);
                return;
            }
            password = response.password;
        }

        const newPassword = await OpenPopup<'delete' | PasswordType | null>('popup-add-password', password);

        if (newPassword === null) {
            return;
        }

        // Remove password
        if (newPassword === 'delete') {
            if (ID !== null) {
                const response = await tcp.SendAndWait('delete-password', {
                    workspaceID: workspace.id,
                    passwordID: ID
                });
                if (response === 'timeout' || response === 'not-sended' || response.status !== 'success') {
                    console.log('Error:', response);
                    return;
                }
                this.allPasswords = this.allPasswords.filter((p) => p.ID !== ID);
            }
        }

        // Add password
        else if (ID === null) {
            const response = await tcp.SendAndWait('add-password', {
                workspaceID: workspace.id,
                password: newPassword
            });
            if (response === 'timeout' || response === 'not-sended' || response.status !== 'success') {
                console.log('Error:', response);
                return;
            }
            this.allPasswords.push(response.password);
        }

        // Edit password
        else {
            const response = await tcp.SendAndWait('edit-password', {
                workspaceID: workspace.id,
                password: newPassword
            });
            if (response === 'timeout' || response === 'not-sended' || response.status !== 'success') {
                console.log('Error:', response);
                return;
            }
            const index = this.allPasswords.findIndex((p) => p.ID === ID);
            if (index !== -1) {
                this.allPasswords[index] = response.password;
            }
        }

        this.UpdatePasswords();
    };
}

export default FeaturePasswordBack;
