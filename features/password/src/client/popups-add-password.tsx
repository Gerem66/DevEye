import { useRef, useState } from 'react';

import styles from './style.module.css';

import { Button, ClosePopup, DialogCancelButton, Popup, SelectInput, TextInput } from 'deveye-sdk-client';
import type { PasswordEntry, PasswordStatus } from '../contracts/domain';

import PasswordGeneratorMenu from './PasswordGeneratorMenu';

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

    // Snapshot of the values the popup opened with, to detect unsaved edits.
    const initial = useRef({ category: '', service: '', email: '', password: '', status: 'active' as PasswordStatus });

    function handleOpenPopup(input: PasswordEntry | null) {
        if (!input || input.id === 0) {
            setMode('add');
            setId(0);
            setCategory('');
            setService('');
            setEmail('');
            setPassword('');
            setStatus('active');
            initial.current = { category: '', service: '', email: '', password: '', status: 'active' };
            return;
        }

        setMode('edit');
        setId(input.id);
        setCategory(input.category);
        setService(input.service);
        setEmail(input.email);
        setPassword(input.password);
        setStatus(input.status);
        initial.current = {
            category: input.category,
            service: input.service,
            email: input.email,
            password: input.password,
            status: input.status
        };
    }

    const dirty =
        category !== initial.current.category ||
        service !== initial.current.service ||
        email !== initial.current.email ||
        password !== initial.current.password ||
        status !== initial.current.status;

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
            width={520}
            onInputChange={handleOpenPopup}
            onClosePopup={() => handleBack()}
            onSubmit={handleAddPassword}
            dirty={dirty}
            onSave={handleAddPassword}
        >
            <p className={styles.popupHint}>
                Stocker un mot de passe est une bonne pratique pour protéger vos comptes. Les informations sont
                chiffrées.
            </p>

            <div className={styles.form}>
                <TextInput
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

                <TextInput
                    name='service'
                    placeholder='Service'
                    value={service}
                    error={errorService}
                    onChange={(e) => setService(e.target.value)}
                />

                <TextInput
                    name='email'
                    placeholder="Nom d'utilisateur / Email"
                    value={email}
                    error={errorEmail}
                    onChange={(e) => setEmail(e.target.value)}
                />

                <div className={styles.passwordField}>
                    <TextInput
                        type='password'
                        placeholder='Mot de passe'
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        enableShowHideButton
                    />
                    <PasswordGeneratorMenu onGenerate={setPassword} />
                </div>

                <SelectInput value={status} onChange={handleStatusPassword}>
                    <option value='active'>Actif</option>
                    <option value='inactive'>Inactif</option>
                    <option value='none'>Indéterminé</option>
                </SelectInput>
            </div>

            <div className={styles.popupActions}>
                <div className={styles.popupActionsLeft}>
                    <DialogCancelButton>Fermer</DialogCancelButton>
                    {mode === 'edit' && (
                        <Button variant='danger' onClick={handleDelete}>
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
