import React from 'react';

import { tcp } from '../../Utils/TCP';
import Popup, { ClosePopup } from '../../Components/Popup';
import { Button, TextInput } from '../../Components';

import styles from './style.module.css';

import type { ContextType } from 'deveye-types';

interface PopupUnlockProps {
    context: ContextType | null;
}

class PopupUnlock extends React.Component<PopupUnlockProps> {
    refInputUnlock: React.RefObject<HTMLInputElement | null> = React.createRef();

    state = {
        inputPassword: '',
        errorPassword: ''
    };

    onUnlockPopupInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        this.setState({ inputPassword: e.target.value });
    };

    onUnlockPopupInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            this.UnlockPopupValidate();
        }
    };

    UnlockPopupValidate = async () => {
        const { inputPassword } = this.state;
        const { context } = this.props;

        if (!context) {
            this.setState({ errorPassword: 'Context not found', inputPassword: '' });
            return;
        }

        if (!inputPassword) {
            this.setState({ errorPassword: 'Mot de passe vide', inputPassword: '' });
            return;
        }

        const response = await tcp.SendAndWait('check-password', {
            contextID: context.id,
            password: inputPassword
        });

        if (response === 'timeout') {
            this.setState({ errorPassword: 'Timeout', inputPassword: '' });
            return;
        } else if (response === 'not-sended') {
            this.setState({ errorPassword: 'Not sended', inputPassword: '' });
            return;
        } else if (response.status !== 0) {
            this.setState({
                errorPassword: response.message || 'Mot de passe incorrect',
                inputPassword: ''
            });
            return;
        }

        this.setState({ inputPassword: '' }, () => {
            ClosePopup('popup-unlock', true);
        });
    };

    onUnlockPopupOpen = () => {
        this.refInputUnlock.current?.focus();
    };

    UnlockPopupClose = () => {
        this.setState({ inputPassword: '', errorPassword: '' });
        ClosePopup('popup-unlock');
    };

    render() {
        return (
            <Popup
                id='popup-unlock'
                title='Déverrouiller'
                onInputChange={this.onUnlockPopupOpen}
                onClosePopup={this.UnlockPopupClose}
            >
                <p>Pour accéder à vos mots de passe, veuillez entrer votre mot de passe principal.</p>

                <div className='form-group'>
                    <TextInput
                        ref={this.refInputUnlock}
                        type='password'
                        placeholder='Mot de passe principal'
                        value={this.state.inputPassword}
                        error={this.state.errorPassword}
                        onChange={this.onUnlockPopupInputChange}
                        onKeyDown={this.onUnlockPopupInputKeyDown}
                        enableShowHideButton
                    />
                </div>

                <div className={`form-group ${styles['popup-check-password-buttons']}`}>
                    <Button onClick={this.UnlockPopupClose} color='#576d8c'>
                        Fermer
                    </Button>
                    <Button onClick={this.UnlockPopupValidate}>Déverrouiller</Button>
                </div>
            </Popup>
        );
    }
}

export default PopupUnlock;
