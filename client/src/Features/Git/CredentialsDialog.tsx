import { useEffect, useState } from 'react';
import type { GitCredential, GitProvider } from 'deveye-types';
import { GIT_CREDENTIAL_LABEL_MAX_LENGTH } from 'deveye-types';
import { Button, Dialog, SelectInput, TextInput } from '@/Components';
import { ws } from '@/api/ws';
import { humanizeError } from '../Projects/api';
import styles from './style.module.css';

interface CredentialsDialogProps {
    open: boolean;
    credentials: GitCredential[];
    canWrite: boolean;
    onClose: () => void;
    /** Rechargez la liste : un jeton a été ajouté, modifié ou retiré. */
    onChanged: () => void;
}

const PROVIDER_LABELS: Record<GitProvider, string> = {
    github: 'GitHub',
    dokploy: 'Dokploy'
};

/** Le formulaire ouvert : un identifiant existant, ou un nouveau. */
type Editing = { credential: GitCredential | null } | null;

/**
 * Les jetons d'accès de l'espace.
 *
 * Ils vivaient auparavant dans le dialogue de liaison d'un dépôt, à l'intérieur
 * d'un projet — un endroit qui ne pouvait pas fonctionner : on pouvait en créer,
 * jamais en supprimer ni en modifier, et un jeton Dokploy n'était pas
 * créable du tout alors que l'onglet Déploiement en réclamait un.
 *
 * Ici, ils sont là où ils appartiennent : à l'espace, partagés par tous les
 * dépôts et toutes les cibles de déploiement, avec les trois opérations.
 *
 * Un secret n'est **jamais relu** — le serveur ne le renvoie pas. Le champ reste
 * donc vide à la ré-ouverture, et le laisser vide veut dire « garder celui en
 * place ».
 */
export function CredentialsDialog({ open, credentials, canWrite, onClose, onChanged }: CredentialsDialogProps) {
    const [editing, setEditing] = useState<Editing>(null);
    const [provider, setProvider] = useState<GitProvider>('github');
    const [label, setLabel] = useState('');
    const [baseUrl, setBaseUrl] = useState('');
    const [secret, setSecret] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmRemove, setConfirmRemove] = useState<number | null>(null);

    useEffect(() => {
        if (!open) return;
        setEditing(null);
        setError(null);
        setConfirmRemove(null);
    }, [open]);

    const openForm = (credential: GitCredential | null) => {
        setEditing({ credential });
        setProvider(credential?.provider ?? 'github');
        setLabel(credential?.label ?? '');
        setBaseUrl(credential?.baseUrl ?? '');
        setSecret('');
        setError(null);
    };

    const submit = async () => {
        if (busy || !label.trim()) return;
        // Dokploy est auto-hébergé : sans l'adresse de l'instance, rien n'est
        // adressable. GitHub, lui, a une API publique — le champ y est masqué.
        if (provider === 'dokploy' && !baseUrl.trim()) {
            setError('Une instance Dokploy a besoin de l’adresse de son API.');
            return;
        }
        const existing = editing?.credential ?? null;
        if (!existing && !secret.trim()) {
            setError('Un jeton sans secret ne sert à rien.');
            return;
        }

        setBusy(true);
        setError(null);
        try {
            const url = provider === 'dokploy' ? baseUrl.trim() : null;
            if (existing) {
                await ws.send('git.credentialUpdate', {
                    credentialId: existing.id,
                    label: label.trim(),
                    baseUrl: url,
                    // Champ vide = inchangé : le serveur ne nous l'a jamais rendu.
                    ...(secret.trim() ? { secret: secret.trim() } : {})
                });
            } else {
                await ws.send('git.credentialAdd', {
                    provider,
                    label: label.trim(),
                    baseUrl: url,
                    secret: secret.trim()
                });
            }
            setEditing(null);
            onChanged();
        } catch (e) {
            setError(humanizeError(e, 'Le jeton n’a pas pu être enregistré.'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async (credentialId: number) => {
        setBusy(true);
        try {
            await ws.send('git.credentialRemove', { credentialId });
            setConfirmRemove(null);
            onChanged();
        } catch (e) {
            setError(humanizeError(e, 'Le retrait a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Jetons d’accès'
            description='Partagés par tous les dépôts et toutes les cibles de déploiement de cet espace.'
            width={640}
            onSubmit={editing ? submit : undefined}
        >
            <div className={styles.form}>
                {error && <p className={styles.error}>{error}</p>}

                {credentials.length === 0 && !editing && <p className={styles.empty}>Aucun jeton enregistré.</p>}

                <ul className={styles.credentialList}>
                    {credentials.map((c) => (
                        <li key={c.id}>
                            <span className={styles.credentialIdent}>
                                <span className={styles.gitItemName}>{c.label}</span>
                                <span className={styles.hint}>
                                    {PROVIDER_LABELS[c.provider]}
                                    {c.baseUrl && ` · ${c.baseUrl}`}
                                    {/* Ce que la suppression va couper, lisible
                                        avant de cliquer plutôt qu'après. */}
                                    {c.useCount > 0
                                        ? ` · utilisé par ${c.useCount} élément${c.useCount > 1 ? 's' : ''}`
                                        : ' · inutilisé'}
                                </span>
                            </span>
                            {canWrite &&
                                (confirmRemove === c.id ? (
                                    <span className={styles.actions}>
                                        <Button
                                            variant='secondary'
                                            onClick={() => setConfirmRemove(null)}
                                            disabled={busy}
                                        >
                                            Annuler
                                        </Button>
                                        <Button variant='danger' onClick={() => void remove(c.id)} disabled={busy}>
                                            Confirmer
                                        </Button>
                                    </span>
                                ) : (
                                    <span className={styles.actions}>
                                        <Button variant='ghost' icon='edit' onClick={() => openForm(c)}>
                                            Modifier
                                        </Button>
                                        <Button variant='ghost' icon='trash' onClick={() => setConfirmRemove(c.id)}>
                                            Retirer
                                        </Button>
                                    </span>
                                ))}
                        </li>
                    ))}
                </ul>

                {canWrite && !editing && (
                    <Button variant='ghost' icon='add' onClick={() => openForm(null)}>
                        Ajouter un jeton
                    </Button>
                )}

                {editing && (
                    <div className={styles.tokenBox}>
                        {!editing.credential && (
                            <label className={styles.field}>
                                <span className={styles.label}>Fournisseur</span>
                                <SelectInput
                                    value={provider}
                                    onChange={(e) => setProvider(e.target.value as GitProvider)}
                                >
                                    <option value='github'>GitHub</option>
                                    <option value='dokploy'>Dokploy</option>
                                </SelectInput>
                            </label>
                        )}

                        <label className={styles.field}>
                            <span className={styles.label}>Nom du jeton</span>
                            <TextInput
                                data-autofocus
                                value={label}
                                maxLength={GIT_CREDENTIAL_LABEL_MAX_LENGTH}
                                placeholder={provider === 'dokploy' ? 'Dokploy — prod' : 'GitHub — perso'}
                                onChange={(e) => setLabel(e.target.value)}
                            />
                        </label>

                        {provider === 'dokploy' && (
                            <label className={styles.field}>
                                <span className={styles.label}>Adresse de l’instance</span>
                                <TextInput
                                    value={baseUrl}
                                    placeholder='https://dokploy.exemple.fr'
                                    onChange={(e) => setBaseUrl(e.target.value)}
                                />
                            </label>
                        )}

                        <label className={styles.field}>
                            <span className={styles.label}>
                                {editing.credential ? 'Nouveau secret (facultatif)' : 'Secret'}
                            </span>
                            {/* `enableShowHideButton` : un secret se relit une
                                fois à la saisie, jamais après. */}
                            <TextInput
                                type='password'
                                enableShowHideButton
                                value={secret}
                                placeholder={provider === 'dokploy' ? 'clé d’API' : 'ghp_…'}
                                onChange={(e) => setSecret(e.target.value)}
                            />
                            {editing.credential && (
                                <span className={styles.hint}>
                                    Laissez vide pour conserver le secret en place — il n’est jamais renvoyé.
                                </span>
                            )}
                        </label>

                        <div className={styles.actions}>
                            <Button variant='secondary' onClick={() => setEditing(null)} disabled={busy}>
                                Annuler
                            </Button>
                            <Button onClick={submit} disabled={busy || !label.trim()}>
                                {busy ? 'Enregistrement…' : 'Enregistrer'}
                            </Button>
                        </div>
                    </div>
                )}
            </div>
        </Dialog>
    );
}

export default CredentialsDialog;
