import { useState } from 'react';
import {
    Button,
    ConfirmDialog,
    Dialog,
    humanizeError,
    invalidate,
    settingsStyles as shell,
    TextInput,
    useResource,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import {
    GIT_CREDENTIAL_LABEL_MAX_LENGTH,
    GIT_CREDENTIAL_SECRET_MAX_LENGTH,
    type GitCredential
} from '../contracts/domain';

import { api } from './api';

/** Le formulaire ouvert : un jeton existant, ou un nouveau. */
type Editing = { credential: GitCredential | null } | null;

/**
 * Les jetons GitHub de l'espace : le panneau de l'onglet « Sources » des réglages
 * de la feature. Rangées, dialogue d'ajout empilé et confirmation reprennent la
 * rangée canonique des réglages, d'où l'emprunt de sa feuille (`settingsStyles`).
 *
 * Un secret n'est jamais relu, le serveur ne le renvoie pas : le champ reste vide
 * à la ré-ouverture, et le laisser vide veut dire « garder celui en place ».
 *
 * Autonome comme tous les panneaux de la coquille, il suit `git.list` et non une
 * clé à lui : un jeton retiré y rend des lignes orphelines, et les sélecteurs des
 * dialogues d'élément suivent par le même canal.
 */
export default function CredentialsPanel({ canWrite }: SettingsPanelProps) {
    const { data: credentials, error: loadError } = useResource(
        'git.list',
        () => api.send('git.credentialList', {}).then((res) => res.credentials),
        'Impossible de charger les jetons.'
    );

    const [editing, setEditing] = useState<Editing>(null);
    const [label, setLabel] = useState('');
    const [secret, setSecret] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    /**
     * Un jeton qui change touche la liste et la fiche ouverte, qui disent toutes
     * deux ce qu'un retrait a coupé : les deux se relisent sans attendre le Live.
     */
    const changed = () => invalidate('git.list', 'git.repo');

    const openForm = (credential: GitCredential | null) => {
        setEditing({ credential });
        setLabel(credential?.label ?? '');
        setSecret('');
        setError(null);
    };

    const submit = async () => {
        if (busy || !label.trim()) return;
        const existing = editing?.credential ?? null;
        if (!existing && !secret.trim()) {
            setError('Un jeton sans secret ne sert à rien.');
            return;
        }

        setBusy(true);
        setError(null);
        try {
            if (existing) {
                await api.send('git.credentialUpdate', {
                    credentialId: existing.id,
                    label: label.trim(),
                    // Champ vide = inchangé : le serveur ne nous l'a jamais rendu.
                    ...(secret.trim() ? { secret: secret.trim() } : {})
                });
            } else {
                await api.send('git.credentialAdd', { label: label.trim(), secret: secret.trim() });
            }
            setEditing(null);
            changed();
        } catch (e) {
            setError(humanizeError(e, 'Le jeton n’a pas pu être enregistré.'));
        } finally {
            setBusy(false);
        }
    };

    /** La confirmation nomme ce que le retrait va couper, avant de cliquer. */
    const askRemove = (credential: GitCredential) => {
        setConfirm({
            title: `Retirer « ${credential.label} » ?`,
            description:
                credential.useCount === 0
                    ? 'Aucun dépôt ne le désigne : son retrait ne change rien à ce qui tourne.'
                    : credential.useCount === 1
                      ? '1 dépôt le désigne encore et cessera d’être synchronisé, jusqu’à en désigner un autre.'
                      : `${credential.useCount} dépôts le désignent encore et cesseront d’être synchronisés, jusqu’à en désigner un autre.`,
            confirmLabel: 'Retirer le jeton',
            onConfirm: () =>
                void (async () => {
                    setBusy(true);
                    try {
                        await api.send('git.credentialRemove', { credentialId: credential.id });
                        changed();
                    } catch (e) {
                        setError(humanizeError(e, 'Le retrait a échoué.'));
                    } finally {
                        setBusy(false);
                    }
                })()
        });
    };

    return (
        <div className={shell.section}>
            {credentials === null && !loadError && <p className={shell.empty}>Chargement…</p>}
            {credentials?.length === 0 && (
                <p className={shell.empty}>
                    {canWrite
                        ? 'Aucun jeton GitHub. Ajoutez-en un : il servira à tous les dépôts de cet espace, et la synchronisation en a besoin.'
                        : 'Aucun jeton GitHub. Un membre disposant du droit d’écriture peut en ajouter un.'}
                </p>
            )}

            <div className={shell.channelList}>
                {(credentials ?? []).map((c) => (
                    <div key={c.id} className={shell.channelRow}>
                        <span className={`icon icon-key ${shell.channelIcon}`} aria-hidden='true' />
                        <span className={shell.channelText}>
                            <span className={shell.channelLabel}>{c.label}</span>
                            {/* La date plutôt qu'une adresse : l'API GitHub est
                                publique, et un jeton finit par expirer. */}
                            <span className={shell.channelMeta}>
                                API GitHub · ajouté le {new Date(c.created * 1000).toLocaleDateString('fr-FR')}
                            </span>
                        </span>
                        <span
                            className={`${shell.channelUsage} ${c.useCount === 0 ? shell.channelUsageIdle : ''}`}
                            title={
                                c.useCount === 0
                                    ? 'Désigné par aucun dépôt'
                                    : `Désigné par ${c.useCount} dépôt${c.useCount > 1 ? 's' : ''}`
                            }
                        >
                            {c.useCount === 0 ? 'inutilisé' : `${c.useCount}×`}
                        </span>
                        {canWrite && (
                            <span className={shell.channelActions}>
                                <button
                                    type='button'
                                    className={shell.rowAction}
                                    title='Modifier ce jeton'
                                    aria-label={`Modifier ${c.label}`}
                                    disabled={busy}
                                    onClick={() => openForm(c)}
                                >
                                    <span className='icon icon-edit' />
                                </button>
                                <button
                                    type='button'
                                    className={`${shell.rowAction} ${shell.rowActionDanger}`}
                                    title='Retirer ce jeton'
                                    aria-label={`Retirer ${c.label}`}
                                    disabled={busy}
                                    onClick={() => askRemove(c)}
                                >
                                    <span className='icon icon-trash' />
                                </button>
                            </span>
                        )}
                    </div>
                ))}
            </div>

            {(error ?? loadError) && <p className={shell.notice}>{error ?? loadError}</p>}

            {canWrite && (
                <div className={shell.sectionActions}>
                    <Button variant='secondary' icon='plus' disabled={busy} onClick={() => openForm(null)}>
                        Ajouter un jeton
                    </Button>
                </div>
            )}

            <Dialog
                open={editing !== null}
                onClose={() => setEditing(null)}
                title={editing?.credential ? 'Modifier le jeton' : 'Nouveau jeton GitHub'}
                description='Il servira à tous les dépôts de cet espace.'
                width={520}
                onSubmit={submit}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setEditing(null)} disabled={busy}>
                            Annuler
                        </Button>
                        <Button onClick={submit} disabled={busy || !label.trim()}>
                            {busy ? 'Enregistrement…' : 'Enregistrer'}
                        </Button>
                    </>
                }
            >
                <div className={shell.section}>
                    <label className={shell.field}>
                        <span className={shell.fieldLabel}>Nom du jeton</span>
                        <TextInput
                            data-autofocus
                            value={label}
                            maxLength={GIT_CREDENTIAL_LABEL_MAX_LENGTH}
                            placeholder='GitHub (perso)'
                            onChange={(e) => setLabel(e.target.value)}
                        />
                    </label>

                    <label className={shell.field}>
                        <span className={shell.fieldLabel}>
                            {editing?.credential ? 'Nouveau jeton (facultatif)' : 'Jeton'}
                        </span>
                        {/* `enableShowHideButton` : un secret se relit une fois à
                            la saisie, jamais après. */}
                        <TextInput
                            type='password'
                            enableShowHideButton
                            value={secret}
                            maxLength={GIT_CREDENTIAL_SECRET_MAX_LENGTH}
                            placeholder='ghp_…'
                            onChange={(e) => setSecret(e.target.value)}
                        />
                        <span className={shell.fieldHint}>
                            {editing?.credential
                                ? 'Laissez vide pour conserver le jeton en place : il n’est jamais renvoyé.'
                                : 'Un jeton en lecture seule suffit (contents: read).'}
                        </span>
                    </label>
                </div>
            </Dialog>

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}
