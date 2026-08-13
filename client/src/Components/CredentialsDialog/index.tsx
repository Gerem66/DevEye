import { useEffect, useState } from 'react';
import type { Credential } from 'deveye-types';
import { CREDENTIAL_LABEL_MAX_LENGTH } from 'deveye-types';
import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import TextInput from '@/Components/TextInput';
import { ws } from '@/api/ws';
import { humanizeError } from '@/Features/Projects/api';
import styles from './CredentialsDialog.module.css';

/**
 * Ce qui distingue les jetons d'une feature de ceux de l'autre.
 *
 * Le comportement est identique — lister, ajouter, modifier, retirer, sans
 * jamais relire un secret — seuls changent les commandes (donc le droit exigé),
 * le vocabulaire, et le fait qu'un service auto-hébergé réclame l'adresse de son
 * instance là où une API publique n'a rien à désigner.
 */
export interface CredentialsKind {
    /** Les quatre commandes WS de la feature propriétaire. */
    commands: {
        list: 'git.credentialList' | 'deploy.credentialList';
        add: 'git.credentialAdd' | 'deploy.credentialAdd';
        update: 'git.credentialUpdate' | 'deploy.credentialUpdate';
        remove: 'git.credentialRemove' | 'deploy.credentialRemove';
    };
    title: string;
    description: string;
    /** Ce qu'un jeton dessert, au singulier : « dépôt », « cible ». */
    noun: string;
    labelPlaceholder: string;
    secretPlaceholder: string;
    /** Le service est auto-hébergé : son adresse fait partie du jeton. */
    needsBaseUrl: boolean;
}

export const GIT_CREDENTIALS: CredentialsKind = {
    commands: {
        list: 'git.credentialList',
        add: 'git.credentialAdd',
        update: 'git.credentialUpdate',
        remove: 'git.credentialRemove'
    },
    title: 'Jetons GitHub',
    description: 'Partagés par tous les dépôts de cet espace.',
    noun: 'dépôt',
    labelPlaceholder: 'GitHub — perso',
    secretPlaceholder: 'ghp_…',
    needsBaseUrl: false
};

export const DEPLOY_CREDENTIALS: CredentialsKind = {
    commands: {
        list: 'deploy.credentialList',
        add: 'deploy.credentialAdd',
        update: 'deploy.credentialUpdate',
        remove: 'deploy.credentialRemove'
    },
    title: 'Accès Dokploy',
    description: 'Partagés par toutes les cibles de déploiement de cet espace.',
    noun: 'cible',
    labelPlaceholder: 'Dokploy — prod',
    secretPlaceholder: 'clé d’API',
    needsBaseUrl: true
};

interface CredentialsDialogProps {
    open: boolean;
    kind: CredentialsKind;
    credentials: Credential[];
    canWrite: boolean;
    onClose: () => void;
    /** Rechargez la liste : un jeton a été ajouté, modifié ou retiré. */
    onChanged: () => void;
}

/** Le formulaire ouvert : un jeton existant, ou un nouveau. */
type Editing = { credential: Credential | null } | null;

/**
 * Les jetons d'accès d'un espace.
 *
 * **Un seul dialogue, deux propriétaires.** Les jetons GitHub appartiennent à la
 * feature Git, les clés Dokploy à la feature Déploiement : ce sont deux droits
 * distincts (lire des dépôts n'autorise pas à poser la clé qui met en
 * production), mais un seul geste. Le composant vit donc hors des deux features,
 * et chacune lui passe son {@link CredentialsKind}.
 *
 * Ils vivaient tous dans l'écran des dépôts, avec un sélecteur de fournisseur —
 * un héritage de l'époque où le déploiement n'était qu'un onglet de projet, sans
 * écran à lui. Il n'y a plus rien à choisir : la porte par laquelle on entre dit
 * déjà de quel jeton il s'agit.
 *
 * Un secret n'est **jamais relu** — le serveur ne le renvoie pas. Le champ reste
 * donc vide à la ré-ouverture, et le laisser vide veut dire « garder celui en
 * place ».
 */
export function CredentialsDialog({ open, kind, credentials, canWrite, onClose, onChanged }: CredentialsDialogProps) {
    const [editing, setEditing] = useState<Editing>(null);
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

    const openForm = (credential: Credential | null) => {
        setEditing({ credential });
        setLabel(credential?.label ?? '');
        setBaseUrl(credential?.baseUrl ?? '');
        setSecret('');
        setError(null);
    };

    const submit = async () => {
        if (busy || !label.trim()) return;
        // Un service auto-hébergé sans adresse n'est pas adressable.
        if (kind.needsBaseUrl && !baseUrl.trim()) {
            setError('Cette instance a besoin de l’adresse de son API.');
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
            if (existing) {
                await ws.send(kind.commands.update, {
                    credentialId: existing.id,
                    label: label.trim(),
                    ...(kind.needsBaseUrl ? { baseUrl: baseUrl.trim() } : {}),
                    // Champ vide = inchangé : le serveur ne nous l'a jamais rendu.
                    ...(secret.trim() ? { secret: secret.trim() } : {})
                });
            } else {
                await ws.send(kind.commands.add, {
                    label: label.trim(),
                    ...(kind.needsBaseUrl ? { baseUrl: baseUrl.trim() } : {}),
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
            await ws.send(kind.commands.remove, { credentialId });
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
            title={kind.title}
            description={kind.description}
            width={640}
            onSubmit={editing ? submit : undefined}
        >
            <div className={styles.form}>
                {error && <p className={styles.error}>{error}</p>}

                {credentials.length === 0 && !editing && <p className={styles.empty}>Aucun jeton enregistré.</p>}

                <ul className={styles.list}>
                    {credentials.map((c) => (
                        <li key={c.id}>
                            <span className={styles.ident}>
                                <span className={styles.name}>{c.label}</span>
                                <span className={styles.hint}>
                                    {c.baseUrl ?? 'API publique'}
                                    {/* Ce que la suppression va couper, lisible
                                        avant de cliquer plutôt qu'après. */}
                                    {c.useCount > 0
                                        ? ` · ${c.useCount} ${kind.noun}${c.useCount > 1 ? 's' : ''}`
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
                    <div className={styles.box}>
                        <label className={styles.field}>
                            <span className={styles.label}>Nom du jeton</span>
                            <TextInput
                                data-autofocus
                                value={label}
                                maxLength={CREDENTIAL_LABEL_MAX_LENGTH}
                                placeholder={kind.labelPlaceholder}
                                onChange={(e) => setLabel(e.target.value)}
                            />
                        </label>

                        {kind.needsBaseUrl && (
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
                                placeholder={kind.secretPlaceholder}
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
