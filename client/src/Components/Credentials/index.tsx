import { useCallback, useEffect, useState } from 'react';
import type { Credential } from 'deveye-types';
import { CREDENTIAL_LABEL_MAX_LENGTH } from 'deveye-types';
import Button from '@/Components/Button';
import TextInput from '@/Components/TextInput';
import { ws } from '@/api/ws';
import { invalidate, useResourceVersion, type ResourceKey } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';
import { humanizeError } from '@/Features/Projects/api';
import styles from './Credentials.module.css';

/**
 * Ce qui distingue les jetons d'une feature de ceux de l'autre.
 *
 * Le comportement est identique — lister, ajouter, modifier, retirer, sans
 * jamais relire un secret — seuls changent les commandes (donc le droit exigé),
 * le vocabulaire, et le fait qu'un service auto-hébergé réclame l'adresse de son
 * instance là où une API publique n'a rien à désigner.
 */
export interface CredentialsKind {
    /** La feature propriétaire : porte le droit d'écriture, et la ressource invalidée. */
    feature: 'git' | 'deploy';
    /** Les quatre commandes WS de la feature propriétaire. */
    commands: {
        list: 'git.credentialList' | 'deploy.credentialList';
        add: 'git.credentialAdd' | 'deploy.credentialAdd';
        update: 'git.credentialUpdate' | 'deploy.credentialUpdate';
        remove: 'git.credentialRemove' | 'deploy.credentialRemove';
    };
    /**
     * La ressource re-sollicitée après chaque geste : la liste de la feature,
     * parce qu'un jeton retiré y rend des lignes orphelines, et qu'elle est déjà
     * ce que le sujet Live de la feature invalide ; les autres écrans (dont les
     * sélecteurs des dialogues d'élément) suivent par le même canal.
     */
    listResource: ResourceKey;
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
    feature: 'git',
    commands: {
        list: 'git.credentialList',
        add: 'git.credentialAdd',
        update: 'git.credentialUpdate',
        remove: 'git.credentialRemove'
    },
    listResource: 'git.list',
    title: 'Jetons GitHub',
    description: 'Partagés par tous les dépôts de cet espace.',
    noun: 'dépôt',
    labelPlaceholder: 'GitHub — perso',
    secretPlaceholder: 'ghp_…',
    needsBaseUrl: false
};

export const DEPLOY_CREDENTIALS: CredentialsKind = {
    feature: 'deploy',
    commands: {
        list: 'deploy.credentialList',
        add: 'deploy.credentialAdd',
        update: 'deploy.credentialUpdate',
        remove: 'deploy.credentialRemove'
    },
    listResource: 'deploy.list',
    title: 'Accès Dokploy',
    description: 'Partagés par toutes les cibles de déploiement de cet espace.',
    noun: 'cible',
    labelPlaceholder: 'Dokploy — prod',
    secretPlaceholder: 'clé d’API',
    needsBaseUrl: true
};

interface CredentialsPanelProps {
    kind: CredentialsKind;
}

/** Le formulaire ouvert : un jeton existant, ou un nouveau. */
type Editing = { credential: Credential | null } | null;

/**
 * Les jetons d'accès d'un espace : le panneau de l'onglet « Sources ».
 *
 * **Un seul panneau, deux propriétaires.** Les jetons GitHub appartiennent à la
 * feature Git, les clés Dokploy à la feature Déploiement : ce sont deux droits
 * distincts (lire des dépôts n'autorise pas à poser la clé qui met en
 * production), mais un seul geste. Le composant vit donc hors des deux features,
 * et chacune lui passe son {@link CredentialsKind}.
 *
 * C'était un dialogue à part, derrière son propre bouton d'en-tête (« Accès
 * Dokploy », « Jetons GitHub »), un troisième endroit à connaître, à côté des
 * réglages. Les sources d'une fonctionnalité vivent désormais toutes au même
 * endroit : Réglages → Sources, où ce panneau est monté. Il se charge et se
 * rafraîchit tout seul, condition pour que la coquille de réglages n'ait rien à
 * savoir de lui.
 *
 * Un secret n'est **jamais relu** — le serveur ne le renvoie pas. Le champ reste
 * donc vide à la ré-ouverture, et le laisser vide veut dire « garder celui en
 * place ».
 */
export function CredentialsPanel({ kind }: CredentialsPanelProps) {
    const permissions = useWorkspacePermissions();
    const canWrite = permissions.canFeature(kind.feature, 'write');
    const listVersion = useResourceVersion(kind.listResource);

    const [credentials, setCredentials] = useState<Credential[] | null>(null);
    const [editing, setEditing] = useState<Editing>(null);
    const [label, setLabel] = useState('');
    const [baseUrl, setBaseUrl] = useState('');
    const [secret, setSecret] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmRemove, setConfirmRemove] = useState<number | null>(null);

    const reload = useCallback(async () => {
        try {
            const res = await ws.send(kind.commands.list, {});
            setCredentials(res.credentials);
        } catch (e) {
            setCredentials([]);
            setError(humanizeError(e, 'Impossible de charger les jetons.'));
        }
    }, [kind]);

    useEffect(() => {
        void reload();
    }, [reload, listVersion]);

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
            invalidate(kind.listResource);
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
            // Un jeton retiré rend ses cibles / dépôts orphelins : la liste de
            // la feature doit le dire sans attendre.
            invalidate(kind.listResource);
        } catch (e) {
            setError(humanizeError(e, 'Le retrait a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={styles.form}>
            {error && <p className={styles.error}>{error}</p>}

            {credentials === null && <p className={styles.empty}>Chargement…</p>}
            {credentials?.length === 0 && !editing && (
                <p className={styles.empty}>
                    {canWrite
                        ? 'Aucun jeton enregistré. Ajoutez-en un ci-dessous.'
                        : 'Aucun jeton enregistré. Un membre disposant du droit d’écriture peut en ajouter un.'}
                </p>
            )}

            <ul className={styles.list}>
                {(credentials ?? []).map((c) => (
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
                                    <Button variant='secondary' onClick={() => setConfirmRemove(null)} disabled={busy}>
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
    );
}

export default CredentialsPanel;
