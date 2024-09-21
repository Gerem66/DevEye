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
    const [mode, setMode] = useState(/** @type {'add' | 'edit'} */ 'add');
    const [ID, setID] = useState(0);
    const [category, setCategory] = useState('');
    const [service, setService] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    // prettier-ignore
    const [status, setStatus] = useState(/** @type {PasswordStatus} */ ('active'));

    const [errorCategory, setErrorCategory] = useState('');
    const [errorService, setErrorService] = useState('');
    const [errorEmail, setErrorEmail] = useState('');

    /** @param {PasswordType | null} password */
    function handleOpenPopup(password) {
        if (!password || password.ID === 0) {
            setMode('add');
            return;
        }

        setMode('edit');
        setID(password.ID);
        setCategory(password.category);
        setService(password.service);
        setEmail(password.email);
        setPassword(password.password);
        setStatus(password.status);
    }

    function handleAddPassword() {
        if (category === '' || service === '' || email === '') {
            setErrorCategory(category === '' ? 'Ce champ est obligatoire' : '');
            setErrorService(service === '' ? 'Ce champ est obligatoire' : '');
            setErrorEmail(email === '' ? 'Ce champ est obligatoire' : '');
            return;
        }

        /** @type {PasswordType} */
        const newPassword = {
            ID,
            category,
            service,
            email,
            password,
            status
        };
        handleBack(newPassword);
    }

    /** @param {PasswordType | null} [newPassword] */
    function handleBack(newPassword = null) {
        setID(0);
        setCategory('');
        setService('');
        setEmail('');
        setPassword('');
        setStatus('active');
        setErrorCategory('');
        setErrorService('');
        setErrorEmail('');
        ClosePopup('popup-add-password', newPassword);
    }

    function handleDelete() {
        ClosePopup('popup-add-password', 'delete');
    }

    /** @param {React.ChangeEvent<HTMLSelectElement>} e */
    function handleStatusPassword(e) {
        // prettier-ignore
        setStatus(/** @type {PasswordStatus} */ (e.target.value));
    }

    return (
        <Popup
            id='popup-add-password'
            title={mode === 'add' ? 'Ajouter un mot de passe' : 'Modifier le mot de passe'}
            onInputChange={handleOpenPopup}
            onClosePopup={() => handleBack()}
        >
            <p>
                Stocker un mot de passe est une bonne pratique pour protéger vos compte.
                <br />
                Les informations concernant les mots de passe sont chiffrées.
            </p>

            <TextInput
                className={styles['password-add-input']}
                list='category'
                placeholder='Catégorie'
                value={category}
                error={errorCategory}
                onChange={(e) => setCategory(e.target.value)}
            />
            <datalist id='category'>
                {passwordCategories.map((category) => (
                    <option key={category} value={category} />
                ))}
            </datalist>

            <div className='form-group'>
                <TextInput
                    name='service'
                    className={styles['password-add-input']}
                    placeholder='Service'
                    value={service}
                    error={errorService}
                    onChange={(e) => setService(e.target.value)}
                />
            </div>

            <div className='form-group'>
                <TextInput
                    name='email'
                    className={styles['password-add-input']}
                    placeholder="Nom d'utilisateur / Email"
                    value={email}
                    error={errorEmail}
                    onChange={(e) => setEmail(e.target.value)}
                />
            </div>

            <div className='form-group'>
                <TextInput
                    className={styles['password-add-input']}
                    type='password'
                    placeholder='Mot de passe'
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    enableShowHideButton
                />
            </div>

            <SelectInput value={status} onChange={handleStatusPassword}>
                <option value='active'>Actif</option>
                <option value='inactive'>Inactif</option>
                <option value='none'>Indéterminé</option>
            </SelectInput>

            <div className={`form-group ${styles['popup-check-password-buttons']}`}>
                <div>
                    <Button onClick={() => handleBack()} color='#576d8c'>
                        Fermer
                    </Button>
                    {mode === 'edit' && (
                        <Button className={styles['password-edit-btn-delete']} onClick={handleDelete} color='#c42e2e'>
                            Supprimer
                        </Button>
                    )}
                </div>
                <Button onClick={handleAddPassword}>{mode === 'add' ? 'Ajouter' : 'Enregistrer'}</Button>
            </div>
        </Popup>
    );
}

export { PasswordPopupAdd };
