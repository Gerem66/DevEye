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
    DEPLOY_CREDENTIAL_LABEL_MAX_LENGTH,
    DEPLOY_CREDENTIAL_SECRET_MAX_LENGTH,
    type DeployCredential
} from '../contracts/domain';

import { api } from './api';

/** Le formulaire ouvert : un accès existant, ou un nouveau. */
type Editing = { credential: DeployCredential | null } | null;

/**
 * Les accès Dokploy de l'espace : le panneau de l'onglet « Sources » des
 * réglages de la feature Déploiement.
 *
 * Il vivait dans la coquille (`sections/CredentialsPanel`, un `CredentialsKind`
 * par porte), partagé avec les jetons GitHub de Git : deux droits distincts
 * (lire des dépôts n'autorise pas à poser la clé qui met en production), mais
 * un seul geste. Le rapatriement du module a ramené sa porte chez lui, sur ses
 * propres commandes (`deploy.credential*`) et son propre contrat
 * (`DeployCredential`, sans `provider`) ; la coquille ne garde que Git.
 *
 * Rangées, dialogue d'ajout empilé et confirmation : les mêmes formes que la
 * liste des canaux de la section Notifications, exprès. C'est la rangée
 * canonique des réglages, d'où l'emprunt de sa feuille (`settingsStyles`), et
 * deux méthodes d'ajout dans une même popup étaient une de trop.
 *
 * Un secret n'est **jamais relu** : le serveur ne le renvoie pas. Le champ reste
 * donc vide à la ré-ouverture, et le laisser vide veut dire « garder celui en
 * place ». Une instance Dokploy est auto-hébergée : son adresse fait partie de
 * l'accès, et elle est obligatoire.
 *
 * Autonome, comme tous les panneaux de la coquille : il se charge, s'invalide
 * et se rafraîchit tout seul. Il suit `deploy.list` et non une clé à lui : un
 * accès retiré y rend des lignes orphelines, elle est déjà ce que le sujet
 * Live de la feature ravive, et les sélecteurs des dialogues d'élément
 * suivent par le même canal.
 */
export default function CredentialsPanel({ canWrite }: SettingsPanelProps) {
    const { data: credentials, error: loadError } = useResource(
        'deploy.list',
        () => api.send('deploy.credentialList', {}).then((res) => res.credentials),
        'Impossible de charger les accès.'
    );

    const [editing, setEditing] = useState<Editing>(null);
    const [label, setLabel] = useState('');
    const [baseUrl, setBaseUrl] = useState('');
    const [secret, setSecret] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    /**
     * Un accès qui change touche la liste (une cible orpheline le dit) et la
     * fiche ouverte (« accès retiré, déclenchement impossible ») : les deux se
     * relisent, sans attendre le sujet Live.
     */
    const changed = () => invalidate('deploy.list', 'deploy.detail');

    const openForm = (credential: DeployCredential | null) => {
        setEditing({ credential });
        setLabel(credential?.label ?? '');
        setBaseUrl(credential?.baseUrl ?? '');
        setSecret('');
        setError(null);
    };

    const submit = async () => {
        if (busy || !label.trim()) return;
        // Un service auto-hébergé sans adresse n'est pas adressable.
        if (!baseUrl.trim()) {
            setError('Cette instance a besoin de l’adresse de son API.');
            return;
        }
        const existing = editing?.credential ?? null;
        if (!existing && !secret.trim()) {
            setError('Un accès sans clé d’API ne sert à rien.');
            return;
        }

        setBusy(true);
        setError(null);
        try {
            if (existing) {
                await api.send('deploy.credentialUpdate', {
                    credentialId: existing.id,
                    label: label.trim(),
                    baseUrl: baseUrl.trim(),
                    // Champ vide = inchangé : le serveur ne nous l'a jamais rendu.
                    ...(secret.trim() ? { secret: secret.trim() } : {})
                });
            } else {
                await api.send('deploy.credentialAdd', {
                    label: label.trim(),
                    baseUrl: baseUrl.trim(),
                    secret: secret.trim()
                });
            }
            setEditing(null);
            changed();
        } catch (e) {
            setError(humanizeError(e, 'L’accès n’a pas pu être enregistré.'));
        } finally {
            setBusy(false);
        }
    };

    /** La confirmation nomme ce que le retrait va couper, avant de cliquer. */
    const askRemove = (credential: DeployCredential) => {
        setConfirm({
            title: `Retirer « ${credential.label} » ?`,
            description:
                credential.useCount === 0
                    ? 'Aucune cible ne le désigne : son retrait ne change rien à ce qui tourne.'
                    : credential.useCount === 1
                      ? '1 cible le désigne encore et cessera d’être déployable, jusqu’à en désigner un autre.'
                      : `${credential.useCount} cibles le désignent encore et cesseront d’être déployables, jusqu’à en désigner un autre.`,
            confirmLabel: 'Retirer l’accès',
            onConfirm: () =>
                void (async () => {
                    setBusy(true);
                    try {
                        await api.send('deploy.credentialRemove', { credentialId: credential.id });
                        // Un accès retiré rend ses cibles orphelines : la
                        // liste de la feature doit le dire sans attendre.
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
                        ? 'Aucun accès Dokploy. Déclarez-en un (adresse de l’instance + clé d’API) pour pouvoir déclarer une cible.'
                        : 'Aucun accès Dokploy. Un membre disposant du droit d’écriture peut en déclarer un.'}
                </p>
            )}

            <div className={shell.channelList}>
                {(credentials ?? []).map((c) => (
                    <div key={c.id} className={shell.channelRow}>
                        <span className={`icon icon-key ${shell.channelIcon}`} aria-hidden='true' />
                        <span className={shell.channelText}>
                            <span className={shell.channelLabel}>{c.label}</span>
                            <span className={shell.channelMeta}>{c.baseUrl ?? 'instance inconnue'}</span>
                        </span>
                        <span
                            className={`${shell.channelUsage} ${c.useCount === 0 ? shell.channelUsageIdle : ''}`}
                            title={
                                c.useCount === 0
                                    ? 'Désigné par aucune cible'
                                    : `Désigné par ${c.useCount} cible${c.useCount > 1 ? 's' : ''}`
                            }
                        >
                            {c.useCount === 0 ? 'inutilisé' : `${c.useCount}×`}
                        </span>
                        {canWrite && (
                            <span className={shell.channelActions}>
                                <button
                                    type='button'
                                    className={shell.rowAction}
                                    title='Modifier cet accès'
                                    aria-label={`Modifier ${c.label}`}
                                    disabled={busy}
                                    onClick={() => openForm(c)}
                                >
                                    <span className='icon icon-edit' />
                                </button>
                                <button
                                    type='button'
                                    className={`${shell.rowAction} ${shell.rowActionDanger}`}
                                    title='Retirer cet accès'
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
                        Ajouter un accès
                    </Button>
                </div>
            )}

            <Dialog
                open={editing !== null}
                onClose={() => setEditing(null)}
                title={editing?.credential ? 'Modifier l’accès' : 'Nouvel accès Dokploy'}
                description='Il servira à toutes les cibles de déploiement de cet espace.'
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
                        <span className={shell.fieldLabel}>Nom de l’accès</span>
                        <TextInput
                            data-autofocus
                            value={label}
                            maxLength={DEPLOY_CREDENTIAL_LABEL_MAX_LENGTH}
                            placeholder='Dokploy — prod'
                            onChange={(e) => setLabel(e.target.value)}
                        />
                    </label>

                    <label className={shell.field}>
                        <span className={shell.fieldLabel}>Adresse de l’instance</span>
                        <TextInput
                            value={baseUrl}
                            placeholder='https://dokploy.exemple.fr'
                            onChange={(e) => setBaseUrl(e.target.value)}
                        />
                    </label>

                    <label className={shell.field}>
                        <span className={shell.fieldLabel}>
                            {editing?.credential ? 'Nouvelle clé d’API (facultatif)' : 'Clé d’API'}
                        </span>
                        {/* `enableShowHideButton` : un secret se relit une fois à
                            la saisie, jamais après. */}
                        <TextInput
                            type='password'
                            enableShowHideButton
                            value={secret}
                            maxLength={DEPLOY_CREDENTIAL_SECRET_MAX_LENGTH}
                            placeholder='clé d’API'
                            onChange={(e) => setSecret(e.target.value)}
                        />
                        {editing?.credential && (
                            <span className={shell.fieldHint}>
                                Laissez vide pour conserver la clé en place : elle n’est jamais renvoyée.
                            </span>
                        )}
                    </label>
                </div>
            </Dialog>

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}
