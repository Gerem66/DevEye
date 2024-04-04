import React from 'react';

import styles from './style.module.css';
import { Popup, Button, TextInput } from '../../Components';
import { ClosePopup } from '../../Components/Popup';
import { tcp } from '../../Utils/TCP';

/**
 * @typedef {import('Types/Context').ContextType} ContextType
 */

const AddContextPopupProps = {
    /** @param {ContextType} context */
    AddContext: (context) => { }
};

class AddContextPopup extends React.Component {
    state = {
        inputContext: '',
        errorContext: ''
    };

    /** @param {React.ChangeEvent<HTMLInputElement>} e */
    onInputContextChange = (e) => {
        this.setState({ inputContext: e.target.value });
        this.setState({ errorContext: '' });
    }

    /** @param {React.KeyboardEvent<HTMLInputElement>} e */
    onInputContextKeyDown = (e) => {
        if (e.key === 'Enter') {
            this.ContextPopupValidate();
        }
    }

    ContextPopupClose = () => {
        this.setState({ inputContext: '', errorContext: '' });
        ClosePopup('popup-add-context');
    }

    ContextPopupValidate = async () => {
        const { AddContext } = this.props;
        const { inputContext } = this.state;

        if (inputContext === '') {
            this.setState({ errorContext: 'Le nom de l\'entreprise ne peut pas être vide' });
            return;
        }

        const result = await tcp.SendAsync('add-context', {
            contextName: inputContext
        });

        if (result === 'timeout' || result === 'not-sended' || result.status !== 0 || result.context === null) {
            this.setState({ errorContext: 'Erreur lors de l\'ajout de l\'entreprise' });
            return;
        }

        AddContext(result.context);
        ClosePopup('popup-add-context');
    }

    render() {
        return (
            <Popup
                id='popup-add-context'
                title='Ajouter une entreprise'
                onClosePopup={this.ContextPopupClose}
            >
                <p>
                    Quel est le nom de la nouvelle entreprise ?
                </p>

                <div className="form-group">
                    <TextInput
                        placeholder="Entreprise X"
                        value={this.state.inputContext}
                        error={this.state.errorContext}
                        onChange={this.onInputContextChange}
                        onKeyDown={this.onInputContextKeyDown}
                    />
                </div>

                <div className={`form-group ${styles['popup-check-password-buttons']}`}>
                    <Button onClick={this.ContextPopupClose} color='#576d8c'>Fermer</Button>
                    <Button onClick={this.ContextPopupValidate}>Déverrouiller</Button>
                </div>
            </Popup>
        );
    }
}

AddContextPopup.defaultProps = AddContextPopupProps;
AddContextPopup.prototype.props = AddContextPopupProps;

export default AddContextPopup;
