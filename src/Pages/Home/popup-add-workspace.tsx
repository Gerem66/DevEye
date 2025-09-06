import React from 'react';

import styles from './style.module.css';
import { Popup, Button, TextInput } from '@/Components/index.js';
import { ClosePopup } from '@/Components/Popup';
import { tcp } from '@/Utils/TCP';

import type { DBType_Workspace } from 'deveye-types';

interface AddWorkspacePopupProps {
    AddWorkspace: (workspace: DBType_Workspace) => void;
}

class AddWorkspacePopup extends React.Component<AddWorkspacePopupProps> {
    state = {
        inputWorkspace: '',
        errorWorkspace: ''
    };

    onInputWorkspaceChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        this.setState({ inputWorkspace: e.target.value });
        this.setState({ errorWorkspace: '' });
    };

    oninputWorkspaceKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            this.WorkspacePopupValidate();
        }
    };

    WorkspacePopupClose = () => {
        this.setState({ inputWorkspace: '', errorWorkspace: '' });
        ClosePopup('popup-add-workspace');
    };

    WorkspacePopupValidate = async () => {
        const { AddWorkspace } = this.props;
        const { inputWorkspace } = this.state;

        if (inputWorkspace === '') {
            this.setState({ errorWorkspace: "Le nom de l'entreprise ne peut pas être vide" });
            return;
        }

        const result = await tcp.SendAndWait('add-workspace', {
            workspaceName: inputWorkspace
        });

        if (result === 'timeout' || result === 'not-sended' || result.status !== 'success') {
            this.setState({ errorWorkspace: "Erreur lors de l'ajout de l'entreprise" });
            return;
        }

        AddWorkspace(result.workspace);
        ClosePopup('popup-add-workspace');
    };

    render() {
        return (
            <Popup id='popup-add-workspace' title='Ajouter une entreprise' onClosePopup={this.WorkspacePopupClose}>
                <p>Quel est le nom de la nouvelle entreprise ?</p>

                <div className='form-group'>
                    <TextInput
                        placeholder='Entreprise X'
                        value={this.state.inputWorkspace}
                        error={this.state.errorWorkspace}
                        onChange={this.onInputWorkspaceChange}
                        onKeyDown={this.oninputWorkspaceKeyDown}
                    />
                </div>

                <div className={`form-group ${styles['popup-check-password-buttons']}`}>
                    <Button onClick={this.WorkspacePopupClose} color='#576d8c'>
                        Fermer
                    </Button>
                    <Button onClick={this.WorkspacePopupValidate}>Déverrouiller</Button>
                </div>
            </Popup>
        );
    }
}

export default AddWorkspacePopup;
