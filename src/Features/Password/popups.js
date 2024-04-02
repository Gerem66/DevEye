import { useState } from 'react';

import styles from './style.module.css';

import { ClosePopup } from '../../Components/Popup';
import { Popup, Button, TextInput, SelectInput } from '../../Components';

/**
 * @typedef {import('Types/Password').PasswordType} PasswordType
 * @typedef {import('Types/Password').PasswordStatus} PasswordStatus
 */

/**
 * @param {Object} props
 * @param {string[]} props.passwordCategories
 */
function PasswordPopupAdd({ passwordCategories }) {
    const [ mode, setMode ] = useState(/** @type {'add' | 'edit'} */ ('add'));
    const [ category, setCategory ] = useState('');
    const [ service, setService ] = useState('');
    const [ email, setEmail ] = useState('');
    const [ password, setPassword ] = useState('');
    const [ status, setStatus ] = useState(/** @type {PasswordStatus} */ ('active'));

    /** @param {PasswordType | null} password */
    function handleOpenPopup(password) {
        if (password === null) {
            setMode('add');
            return;
        }

        setMode('edit');
        setCategory(password.category);
        setService(password.service);
        setEmail(password.email);
        setPassword(password.password);
        setStatus(password.status);
    }

    function handleAddPassword() {
        /** @type {PasswordType} */
        const newPassword = {
            ID: 0,
            category,
            service,
            email,
            password,
            status
        };
        ClosePopup('popup-add-password', newPassword);
    }

    function handleBack() {
        setCategory('');
        setService('');
        setEmail('');
        setPassword('');
        setStatus('active');
        ClosePopup('popup-add-password');
    }

    /** @param {React.ChangeEvent<HTMLSelectElement>} e */
    function handleStatusPassword(e) {
        setStatus(/** @type {PasswordStatus} */ (e.target.value));
    }

    return (
        <Popup
            id='popup-add-password'
            title={mode === 'add' ? 'Ajouter un mot de passe' : 'Modifier le mot de passe'}
            onInputChange={handleOpenPopup}
            onClosePopup={handleBack}
        >
            <p>
                Stocker un mot de passe est une bonne pratique pour protéger vos compte.
                <br />
                Les informations concernant les mots de passe sont chiffrées.
            </p>

            <TextInput
                className={styles['password-add-input']}
                list="category"
                placeholder="Catégorie"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
            />
            <datalist id="category">
                {passwordCategories.map((category) => (
                    <option key={category} value={category} />
                ))}
            </datalist>

            <div className="form-group">
                <TextInput
                    name="service"
                    className={styles['password-add-input']}
                    placeholder="Service"
                    value={service}
                    onChange={(e) => setService(e.target.value)}
                />
            </div>

            <div className="form-group">
                <TextInput
                    name="email"
                    className={styles['password-add-input']}
                    placeholder="Nom d'utilisateur / Email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                />
            </div>

            <div className="form-group">
                <TextInput
                    className={styles['password-add-input']}
                    type="password"
                    placeholder="Mot de passe"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    enableShowHideButton
                />
            </div>

            <SelectInput value={status} onChange={handleStatusPassword}>
                <option value="active">Actif</option>
                <option value="inactive">Inactif</option>
                <option value="none">Indéterminé</option>
            </SelectInput> 

            <div className={`form-group ${styles['popup-check-password-buttons']}`}>
                <div>
                    <Button onClick={handleBack} color='#576d8c'>Fermer</Button>
                    {mode === 'edit' && (
                        <Button
                            className={styles['password-edit-btn-delete']}
                            onClick={handleBack}
                            color='#c42e2e'
                        >
                            Supprimer
                        </Button>
                    )}
                </div>
                <Button onClick={handleAddPassword}>{mode === 'add' ? 'Ajouter' : 'Modifier'}</Button>
            </div>
        </Popup>
    );
}

function PasswordPopupEdit() {
    return (
        <></>
    );
}

export { PasswordPopupAdd };
