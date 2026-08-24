import { useCallback, useEffect, useState } from 'react';
import type { Credential } from '@deveye/types';
import { CREDENTIAL_LABEL_MAX_LENGTH } from '@deveye/types';

import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import { ConfirmDialog, type ConfirmRequest } from '@/Components/ConfirmDialog';
import { Dialog } from '@/Components/Dialog';
import TextInput from '@/Components/TextInput';
import { invalidate, useResourceVersion, type ResourceKey } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';
import { humanizeError } from '@/Features/Projects/api';

import styles from '../FeatureSettings.module.css';

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
    /** Ce qu'un jeton dessert, au singulier : « dépôt », « cible ». */
    noun: string;
    /** Sous le titre du dialogue d'ajout : à quoi ce jeton va servir. */
    formHint: string;
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
    noun: 'dépôt',
    formHint: 'Il servira à tous les dépôts de cet espace.',
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
    noun: 'cible',
    formHint: 'Il servira à toutes les cibles de déploiement de cet espace.',
    labelPlaceholder: 'Dokploy — prod',
    secretPlaceholder: 'clé d’API',
    needsBaseUrl: true
};

/** Le formulaire ouvert : un jeton existant, ou un nouveau. */
type Editing = { credential: Credential | null } | null;

/**
 * Les jetons d'accès d'un espace : le panneau de l'onglet « Sources ».
 *
 * **Un seul panneau, deux propriétaires.** Les jetons GitHub appartiennent à la
 * feature Git, les clés Dokploy à la feature Déploiement : ce sont deux droits
 * distincts (lire des dépôts n'autorise pas à poser la clé qui met en
 * production), mais un seul geste. Le panneau vit donc dans la coquille, et
 * `SourcesSection` lui passe son {@link CredentialsKind}.
 *
 * Rangées, dialogue d'ajout empilé et confirmation : les mêmes formes que la
 * liste des canaux de la section Notifications, exprès. C'est la rangée
 * canonique des réglages, et deux méthodes d'ajout dans une même popup étaient
 * une de trop. Les classes `channel*` sont partagées pour la même raison.
 *
 * Un secret n'est **jamais relu** — le serveur ne le renvoie pas. Le champ reste
 * donc vide à la ré-ouverture, et le laisser vide veut dire « garder celui en
 * place ».
 */
export function CredentialsPanel({ kind }: { kind: CredentialsKind }) {
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
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

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

    /** La confirmation nomme ce que le retrait va couper, avant de cliquer. */
    const askRemove = (credential: Credential) => {
        const plural = credential.useCount > 1 ? 's' : '';
        setConfirm({
            title: `Retirer « ${credential.label} » ?`,
            description:
                credential.useCount === 0
                    ? 'Personne ne le désigne : son retrait ne change rien à ce qui tourne.'
                    : `${credential.useCount} ${kind.noun}${plural} le désignent encore et perdront leur accès, jusqu’à en désigner un autre.`,
            confirmLabel: 'Retirer le jeton',
            onConfirm: () =>
                void (async () => {
                    setBusy(true);
                    try {
                        await ws.send(kind.commands.remove, { credentialId: credential.id });
                        // Un jeton retiré rend ses cibles / dépôts orphelins :
                        // la liste de la feature doit le dire sans attendre.
                        invalidate(kind.listResource);
                    } catch (e) {
                        setError(humanizeError(e, 'Le retrait a échoué.'));
                    } finally {
                        setBusy(false);
                    }
                })()
        });
    };

    return (
        <div className={styles.section}>
            {credentials === null && <p className={styles.empty}>Chargement…</p>}
            {credentials?.length === 0 && (
                <p className={styles.empty}>
                    {canWrite
                        ? 'Aucun jeton enregistré. Ajoutez-en un ci-dessous.'
                        : 'Aucun jeton enregistré. Un membre disposant du droit d’écriture peut en ajouter un.'}
                </p>
            )}

            <div className={styles.channelList}>
                {(credentials ?? []).map((c) => (
                    <div key={c.id} className={styles.channelRow}>
                        <span className={`icon icon-key ${styles.channelIcon}`} aria-hidden='true' />
                        <span className={styles.channelText}>
                            <span className={styles.channelLabel}>{c.label}</span>
                            <span className={styles.channelMeta}>{c.baseUrl ?? 'API publique'}</span>
                        </span>
                        <span
                            className={`${styles.channelUsage} ${c.useCount === 0 ? styles.channelUsageIdle : ''}`}
                            title={
                                c.useCount === 0
                                    ? 'Désigné par personne'
                                    : `Désigné par ${c.useCount} ${kind.noun}${c.useCount > 1 ? 's' : ''}`
                            }
                        >
                            {c.useCount === 0 ? 'inutilisé' : `${c.useCount}×`}
                        </span>
                        {canWrite && (
                            <span className={styles.channelActions}>
                                <button
                                    type='button'
                                    className={styles.rowAction}
                                    title='Modifier ce jeton'
                                    aria-label={`Modifier ${c.label}`}
                                    disabled={busy}
                                    onClick={() => openForm(c)}
                                >
                                    <span className='icon icon-edit' />
                                </button>
                                <button
                                    type='button'
                                    className={`${styles.rowAction} ${styles.rowActionDanger}`}
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

            {error && <p className={styles.notice}>{error}</p>}

            {canWrite && (
                <div className={styles.sectionActions}>
                    <Button variant='secondary' icon='plus' disabled={busy} onClick={() => openForm(null)}>
                        Ajouter un jeton
                    </Button>
                </div>
            )}

            <Dialog
                open={editing !== null}
                onClose={() => setEditing(null)}
                title={editing?.credential ? 'Modifier le jeton' : 'Nouveau jeton'}
                description={kind.formHint}
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
                <div className={styles.section}>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Nom du jeton</span>
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
                            <span className={styles.fieldLabel}>Adresse de l’instance</span>
                            <TextInput
                                value={baseUrl}
                                placeholder='https://dokploy.exemple.fr'
                                onChange={(e) => setBaseUrl(e.target.value)}
                            />
                        </label>
                    )}

                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>
                            {editing?.credential ? 'Nouveau secret (facultatif)' : 'Secret'}
                        </span>
                        {/* `enableShowHideButton` : un secret se relit une fois à
                            la saisie, jamais après. */}
                        <TextInput
                            type='password'
                            enableShowHideButton
                            value={secret}
                            placeholder={kind.secretPlaceholder}
                            onChange={(e) => setSecret(e.target.value)}
                        />
                        {editing?.credential && (
                            <span className={styles.fieldHint}>
                                Laissez vide pour conserver le secret en place — il n’est jamais renvoyé.
                            </span>
                        )}
                    </label>
                </div>
            </Dialog>

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}

export default CredentialsPanel;
