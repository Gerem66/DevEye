import React from 'react';

import styles from './style.module.css';

import { tcp } from '../../Utils/TCP';
import Popup, { ClosePopup } from '../../Components/Popup';
import { Button, TextInput } from '../../Components';

/**
 * @typedef {import('Types/Context').ContextType} ContextType
 */

const FeaturePasswordProps = {
    /** @type {ContextType | null} */
    context: null
};

class PopupUnlock extends React.Component {
    /** @type {React.RefObject<HTMLInputElement>} */
    refInputUnlock = React.createRef();

    state = {
        inputPassword: '',
        errorPassword: ''
    }

    /** @param {React.ChangeEvent<HTMLInputElement>} e */
    onUnlockPopupInputChange = (e) => {
        this.setState({ inputPassword: e.target.value });
    }

    /** @param {React.KeyboardEvent<HTMLInputElement>} e */
    onUnlockPopupInputKeyDown = (e) => {
        if (e.key === 'Enter') {
            this.UnlockPopupValidate();
        }
    }

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

        const response = await tcp.SendAsync('check-password', {
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
    }

    onUnlockPopupOpen = () => {
        this.refInputUnlock.current?.focus();
    }

    UnlockPopupClose = () => {
        this.setState({ inputPassword: '', errorPassword: '' });
        ClosePopup('popup-unlock');
    }

    render() {
        return (
            <Popup
                id='popup-unlock'
                title='Déverrouiller'
                onInputChange={this.onUnlockPopupOpen}
                onClosePopup={this.UnlockPopupClose}
            >
                <p>
                    Pour accéder à vos mots de passe, veuillez entrer votre mot de passe principal.
                </p>

                <div className="form-group">
                    <TextInput
                        ref={this.refInputUnlock}
                        type="password"
                        placeholder="Mot de passe principal"
                        value={this.state.inputPassword}
                        error={this.state.errorPassword}
                        onChange={this.onUnlockPopupInputChange}
                        onKeyDown={this.onUnlockPopupInputKeyDown}
                        enableShowHideButton
                    />
                </div>

                <div className={`form-group ${styles['popup-check-password-buttons']}`}>
                    <Button onClick={this.UnlockPopupClose} color='#576d8c'>Fermer</Button>
                    <Button onClick={this.UnlockPopupValidate}>Déverrouiller</Button>
                </div>
            </Popup>
        );
    }
}

PopupUnlock.defaultProps = FeaturePasswordProps;
PopupUnlock.prototype.props = FeaturePasswordProps;

export default PopupUnlock;
