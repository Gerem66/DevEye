import { useEffect, useState } from 'react';
import type { Credential, DeployCandidate, DeployTarget, DeployTargetKind } from 'deveye-types';
import { DEPLOY_TARGET_NAME_MAX_LENGTH } from 'deveye-types';
import { Button, Dialog, SelectInput, TextInput } from '@/Components';
import { ws } from '@/api/ws';
import { invalidate } from '@/stores/invalidation';
import { humanizeError } from '@/Features/Projects/api';
import styles from './style.module.css';

interface TargetDialogProps {
    open: boolean;
    /** La cible modifiée, ou `null` pour une déclaration. */
    target: DeployTarget | null;
    onClose: () => void;
    onSaved: (target: DeployTarget) => void;
    /** Absent = pas de suppression proposée (on modifie depuis un projet). */
    onRemoved?: () => void;
}

/**
 * Déclarer une cible de déploiement, ou la régler.
 *
 * **Rien ne se crée chez le fournisseur** : DevEye ne fait que pointer une
 * application ou une pile qui existe déjà chez Dokploy. Le dialogue interroge
 * donc l'instance pour proposer ce qu'elle déclare, et garde un repli manuel
 * pour le jour où le décodeur ne reconnaîtra pas une forme de réponse.
 *
 * Il charge lui-même les accès de l'espace et dit ce qui manque quand il n'y en
 * a aucun — c'est ce qui permet de l'ouvrir aussi bien depuis la feature que
 * depuis un projet, sans que chaque appelant ait à les lire d'abord.
 */
export function TargetDialog({ open, target, onClose, onSaved, onRemoved }: TargetDialogProps) {
    const [credentials, setCredentials] = useState<Credential[] | null>(null);
    const [credentialId, setCredentialId] = useState('');
    const [candidates, setCandidates] = useState<DeployCandidate[]>([]);
    const [externalId, setExternalId] = useState('');
    const [name, setName] = useState('');
    const [kind, setKind] = useState<DeployTargetKind>('application');
    const [busy, setBusy] = useState(false);
    const [loadingCandidates, setLoadingCandidates] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmRemove, setConfirmRemove] = useState(false);

    useEffect(() => {
        if (!open) return;
        setExternalId(target?.externalId ?? '');
        setName(target?.name ?? '');
        setKind(target?.kind ?? 'application');
        setConfirmRemove(false);
        setError(null);
        void (async () => {
            try {
                const res = await ws.send('deploy.credentialList', {});
                setCredentials(res.credentials);
                setCredentialId(
                    target?.credentialId ? String(target.credentialId) : String(res.credentials[0]?.id ?? '')
                );
            } catch (e) {
                setCredentials([]);
                setError(humanizeError(e, 'Impossible de charger les accès de l’espace.'));
            }
        })();
    }, [open, target]);

    /*
     * Les applications de l'instance, chargées **d'elles-mêmes**.
     *
     * C'est la seule commande du module qui appelle un service externe en
     * direct : attendre un tour d'ordonnanceur pour remplir un sélecteur
     * n'aurait aucun sens. Elle se déclenchait autrefois sur un bouton
     * « Lister les applications » — un geste que personne n'avait de raison de
     * ne pas faire, donc un clic imposé avant le vrai choix. Le sélecteur se
     * remplit maintenant dès qu'une instance est désignée, et se recharge quand
     * on en change.
     *
     * `busy` reste au dépôt du formulaire : une interrogation en cours ne doit
     * pas se lire comme un enregistrement en cours, seul le sélecteur s'en
     * trouve occupé.
     */
    useEffect(() => {
        if (!open || !credentialId) {
            setCandidates([]);
            return;
        }
        let alive = true;
        setLoadingCandidates(true);
        setCandidates([]);
        void (async () => {
            try {
                const res = await ws.send('deploy.candidates', { credentialId: Number(credentialId) });
                // Une réponse d'une instance qu'on ne regarde plus n'a rien à
                // dire : changer de jeton avant qu'elle n'arrive est courant.
                if (!alive) return;
                setCandidates(res.candidates);
                setError(null);
            } catch (e) {
                // Une instance injoignable n'empêche pas de déclarer la cible :
                // le repli manuel plus bas reste ouvert, d'où l'erreur affichée
                // sans que rien ne se ferme.
                if (alive) setError(humanizeError(e, 'Impossible de joindre l’instance Dokploy.'));
            } finally {
                if (alive) setLoadingCandidates(false);
            }
        })();
        return () => {
            alive = false;
        };
    }, [open, credentialId]);

    /** Choisir dans la liste remplit tout le reste : type, identifiant, nom. */
    const pick = (chosen: string) => {
        setExternalId(chosen);
        const candidate = candidates.find((c) => c.externalId === chosen);
        if (!candidate) return;
        setKind(candidate.kind);
        setName(candidate.name);
    };

    const submit = async () => {
        if (busy || !credentialId || !externalId.trim()) return;
        setBusy(true);
        setError(null);
        try {
            const payload = {
                kind,
                externalId: externalId.trim(),
                // Un nom laissé vide retombe sur l'identifiant : une cible sans
                // intitulé resterait désignable, mais illisible dans une liste.
                name: name.trim() || externalId.trim()
            };
            const res = target
                ? await ws.send('deploy.update', {
                      targetId: target.id,
                      credentialId: Number(credentialId),
                      ...payload
                  })
                : await ws.send('deploy.add', { credentialId: Number(credentialId), ...payload });
            invalidate('deploy.list', 'deploy.count', 'deploy.detail');
            onSaved(res.target);
        } catch (e) {
            setError(humanizeError(e, 'L’enregistrement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!target || busy) return;
        setBusy(true);
        try {
            await ws.send('deploy.remove', { targetId: target.id });
            invalidate('deploy.list', 'deploy.count', 'project.board');
            onRemoved?.();
        } catch (e) {
            setError(humanizeError(e, 'La suppression a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    /** Aucun accès Dokploy : rien n'est déployable tant qu'il n'y en a pas un. */
    const nothingToUse = credentials !== null && credentials.length === 0;

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={target ? 'Régler la cible' : 'Déclarer une cible de déploiement'}
            width={560}
            onSubmit={submit}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={submit} disabled={busy || nothingToUse || !externalId.trim()}>
                        {busy ? 'Enregistrement…' : target ? 'Enregistrer' : 'Déclarer'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                {nothingToUse ? (
                    <p className={styles.hint}>
                        Aucun accès Dokploy dans cet espace. Ajoutez-en un (adresse de l’instance + clé d’API) depuis le
                        bouton « Accès Dokploy », en tête de la feature, puis revenez ici.
                    </p>
                ) : (
                    <>
                        <label className={styles.field}>
                            <span className={styles.label}>Instance Dokploy</span>
                            <SelectInput value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
                                {(credentials ?? []).map((c) => (
                                    <option key={c.id} value={c.id}>
                                        {c.label} — {c.baseUrl}
                                    </option>
                                ))}
                            </SelectInput>
                        </label>

                        {/* Toujours présent, y compris vide : c'est le champ par
                            lequel on choisit, et le faire apparaître seulement
                            une fois rempli déplacerait le formulaire sous les
                            yeux au moment où l'instance répond. Sa première
                            ligne porte donc son propre état. */}
                        <label className={styles.field}>
                            <span className={styles.label}>Cible</span>
                            <SelectInput
                                value={externalId}
                                onChange={(e) => pick(e.target.value)}
                                disabled={loadingCandidates || candidates.length === 0}
                            >
                                <option value=''>
                                    {loadingCandidates
                                        ? 'Interrogation de l’instance…'
                                        : candidates.length === 0
                                          ? 'Cette instance ne déclare aucune application'
                                          : 'Choisir…'}
                                </option>
                                {/* La cible réglée mais absente de la liste — une
                                    application retirée chez le fournisseur, ou
                                    saisie à la main. Sans cette entrée, le
                                    sélecteur afficherait « Choisir… » sur une
                                    cible qui en a pourtant une. */}
                                {externalId !== '' && !candidates.some((c) => c.externalId === externalId) && (
                                    <option value={externalId}>{externalId} — hors liste</option>
                                )}
                                {candidates.map((c) => (
                                    <option key={`${c.kind}:${c.externalId}`} value={c.externalId}>
                                        {c.kind === 'compose' ? '🧩 ' : '📦 '}
                                        {c.name}
                                        {c.path ? ` — ${c.path}` : ''}
                                    </option>
                                ))}
                            </SelectInput>
                        </label>

                        {/* Repli manuel : si l'instance répond dans une forme que
                            le décodeur ne reconnaît pas, on doit quand même
                            pouvoir déclarer la cible. */}
                        <label className={styles.field}>
                            <span className={styles.label}>…ou identifiant de cible</span>
                            <TextInput
                                value={externalId}
                                placeholder='applicationId ou composeId'
                                onChange={(e) => setExternalId(e.target.value)}
                            />
                        </label>

                        <label className={styles.field}>
                            <span className={styles.label}>Type</span>
                            <SelectInput value={kind} onChange={(e) => setKind(e.target.value as DeployTargetKind)}>
                                <option value='application'>Application</option>
                                <option value='compose'>Pile compose</option>
                            </SelectInput>
                            <span className={styles.hint}>
                                Les deux ne se déclenchent pas par la même procédure : une cible du mauvais type reste
                                indéployable.
                            </span>
                        </label>

                        <label className={styles.field}>
                            <span className={styles.label}>Intitulé</span>
                            <TextInput
                                value={name}
                                maxLength={DEPLOY_TARGET_NAME_MAX_LENGTH}
                                placeholder='Le nom sous lequel vous la reconnaissez'
                                onChange={(e) => setName(e.target.value)}
                            />
                        </label>
                    </>
                )}

                {error && <p className={styles.error}>{error}</p>}

                {target && onRemoved && (
                    <div className={styles.dangerZone}>
                        <div className={styles.dangerText}>
                            <strong>Supprimer cette cible</strong>
                            <span className={styles.hint}>
                                Son historique part avec elle, et les projets qui la déployaient perdent leur liaison.
                                L’application, elle, continue de tourner chez Dokploy.
                            </span>
                        </div>
                        {confirmRemove ? (
                            <div className={styles.actions}>
                                <Button variant='secondary' onClick={() => setConfirmRemove(false)} disabled={busy}>
                                    Annuler
                                </Button>
                                <Button variant='danger' onClick={() => void remove()} disabled={busy}>
                                    Confirmer
                                </Button>
                            </div>
                        ) : (
                            <Button
                                variant='danger'
                                icon='trash'
                                onClick={() => setConfirmRemove(true)}
                                disabled={busy}
                            >
                                Supprimer
                            </Button>
                        )}
                    </div>
                )}
            </div>
        </Dialog>
    );
}

export default TargetDialog;
