import { useState } from 'react';
import { normalizeRemoteOrigin, REMOTE_LABEL_MAX, type RemoteInstance } from '@deveye/types';
import { humanizeError } from '@/api/useResource';
import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import Popup, { ClosePopup } from '@/Components/Popup';
import SegmentedControl from '@/Components/SegmentedControl';
import TextInput from '@/Components/TextInput';
import styles from './style.module.css';

export const CREATE_WORKSPACE_POPUP = 'popup-create-workspace';

/** Longueur retenue côté contrat (`workspace.add`). */
const NAME_MAX = 120;

type Where = 'local' | 'remote';

const WHERE_OPTIONS = [
    { value: 'local', label: 'Sur cette instance' },
    { value: 'remote', label: 'Instance distante', title: 'Un autre serveur DevEye, le vôtre par exemple' }
] as const;

/**
 * Ce que l'appelant doit faire ensuite : créer l'espace ici, ou accueillir une
 * instance distante déjà enregistrée (la popup s'en charge, c'est elle qui
 * tient le formulaire où dire ce qui cloche).
 */
export type CreateWorkspaceChoice = { kind: 'local'; name: string } | { kind: 'remote'; instance: RemoteInstance };

/**
 * Création d'un espace de travail, ou ajout d'une instance distante dont les
 * espaces viendront se ranger sous ceux d'ici. Se résout avec le choix fait, ou
 * `null` si l'utilisateur annule.
 */
export default function CreateWorkspacePopup() {
    const [where, setWhere] = useState<Where>('local');
    const [name, setName] = useState('');
    const [address, setAddress] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const close = (value: CreateWorkspaceChoice | null): void => {
        setWhere('local');
        setName('');
        setAddress('');
        setError(null);
        ClosePopup(CREATE_WORKSPACE_POPUP, value);
    };

    const trimmed = name.trim();
    const origin = normalizeRemoteOrigin(address);
    // Une page servie en HTTPS ne peut joindre que du HTTPS : le navigateur
    // bloquerait tout appel vers l'instance, sans que rien ne le dise.
    const mixedContent = origin !== null && origin.startsWith('http:') && window.location.protocol === 'https:';
    const ready = where === 'local' ? Boolean(trimmed) : Boolean(trimmed) && origin !== null && !mixedContent;

    const submit = (): void => {
        if (!ready || busy) return;
        if (where === 'local') {
            close({ kind: 'local', name: trimmed });
            return;
        }
        setBusy(true);
        setError(null);
        // La liste des instances appartient au compte d'ici, où que l'on se trouve.
        ws.local
            .send('remote.add', { label: trimmed, origin: origin! })
            .then((res) => close({ kind: 'remote', instance: res.instance }))
            .catch((e: unknown) => setError(humanizeError(e, 'L’instance n’a pas pu être ajoutée.')))
            .finally(() => setBusy(false));
    };

    return (
        <Popup
            id={CREATE_WORKSPACE_POPUP}
            title='Nouvel espace'
            width={440}
            onClosePopup={() => close(null)}
            onSubmit={submit}
        >
            <SegmentedControl
                options={WHERE_OPTIONS}
                value={where}
                onChange={(next) => {
                    setWhere(next);
                    setError(null);
                }}
                fullWidth
                aria-label='Où se trouve l’espace'
            />
            {where === 'local' ? (
                <>
                    <p className={styles.popupHint}>
                        Un espace regroupe ses propres notes, mots de passe et réglages. Vous en êtes le propriétaire et
                        pourrez y inviter d’autres personnes.
                    </p>
                    <TextInput
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={NAME_MAX}
                        placeholder='Nom de l’espace'
                        aria-label='Nom de l’espace'
                    />
                </>
            ) : (
                <>
                    <p className={styles.popupHint}>
                        Les espaces d’un autre serveur DevEye s’ajoutent à votre liste. Vous vous y connectez avec votre
                        compte de là-bas, depuis ce navigateur : les deux serveurs ne se parlent jamais, et celui-ci ne
                        retient que l’adresse.
                    </p>
                    <div className={styles.popupFields}>
                        <TextInput
                            value={address}
                            onChange={(e) => setAddress(e.target.value)}
                            maxLength={255}
                            placeholder='https://deveye.exemple.fr'
                            aria-label='Adresse de l’instance'
                            inputMode='url'
                            autoCapitalize='none'
                            spellCheck={false}
                            error={address.trim() !== '' && origin === null ? 'Adresse invalide' : undefined}
                        />
                        <TextInput
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            maxLength={REMOTE_LABEL_MAX}
                            placeholder='Nom affiché (ex. Maison)'
                            aria-label='Nom affiché de l’instance'
                        />
                    </div>
                    {mixedContent && (
                        <p className={styles.popupError} role='alert'>
                            Cette page est servie en HTTPS : le navigateur ne la laissera pas joindre une adresse en
                            http://. L’instance doit être servie en HTTPS elle aussi.
                        </p>
                    )}
                    {address.trim() !== '' && origin === null && (
                        <p className={styles.popupError} role='alert'>
                            Adresse attendue sous la forme https://hôte ou https://hôte:port, sans chemin.
                        </p>
                    )}
                </>
            )}
            {error && (
                <p className={styles.popupError} role='alert'>
                    {error}
                </p>
            )}
            <div className={styles.popupActions}>
                <Button variant='secondary' onClick={() => close(null)}>
                    Annuler
                </Button>
                <Button onClick={submit} disabled={!ready || busy}>
                    {where === 'local' ? 'Créer' : 'Ajouter'}
                </Button>
            </div>
        </Popup>
    );
}
