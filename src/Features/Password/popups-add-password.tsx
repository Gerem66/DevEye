import { useState } from 'react';

import styles from './style.module.css';

import { Button, Popup, SelectInput, TextInput } from '@/Components';
import { ClosePopup } from '@/Components/Popup';

import type { PasswordEntry, PasswordStatus } from 'deveye-types';

type PopupResult = PasswordEntry | 'delete' | null;

interface PasswordPopupAddProps {
    passwordCategories: string[];
}

function PasswordPopupAdd({ passwordCategories }: PasswordPopupAddProps) {
    const [mode, setMode] = useState<'add' | 'edit'>('add');
    const [id, setId] = useState(0);
    const [category, setCategory] = useState('');
    const [service, setService] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [status, setStatus] = useState<PasswordStatus>('active');

    const [errorCategory, setErrorCategory] = useState('');
    const [errorService, setErrorService] = useState('');
    const [errorEmail, setErrorEmail] = useState('');

    function handleOpenPopup(input: PasswordEntry | null) {
        if (!input || input.id === 0) {
            setMode('add');
            setId(0);
            setCategory('');
            setService('');
            setEmail('');
            setPassword('');
            setStatus('active');
            return;
        }

        setMode('edit');
        setId(input.id);
        setCategory(input.category);
        setService(input.service);
        setEmail(input.email);
        setPassword(input.password);
        setStatus(input.status);
    }

    function handleAddPassword() {
        if (category === '' || service === '' || email === '') {
            setErrorCategory(category === '' ? 'Ce champ est obligatoire' : '');
            setErrorService(service === '' ? 'Ce champ est obligatoire' : '');
            setErrorEmail(email === '' ? 'Ce champ est obligatoire' : '');
            return;
        }

        const entry: PasswordEntry = { id, category, service, email, password, status };
        handleBack(entry);
    }

    function handleBack(result: PopupResult = null) {
        setId(0);
        setCategory('');
        setService('');
        setEmail('');
        setPassword('');
        setStatus('active');
        setErrorCategory('');
        setErrorService('');
        setErrorEmail('');
        ClosePopup('popup-add-password', result);
    }

    function handleDelete() {
        handleBack('delete');
    }

    function handleStatusPassword(e: React.ChangeEvent<HTMLSelectElement>) {
        setStatus(e.target.value as PasswordStatus);
    }

    return (
        <Popup
            id='popup-add-password'
            title={mode === 'add' ? 'Ajouter un mot de passe' : 'Modifier le mot de passe'}
            onInputChange={handleOpenPopup}
            onClosePopup={() => handleBack()}
        >
            <p>
                Stocker un mot de passe est une bonne pratique pour protéger vos comptes.
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
                {passwordCategories.map((c) => (
                    <option key={c} value={c} />
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
export type { PopupResult };

