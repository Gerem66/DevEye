import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Button,
    Dialog,
    FeatureSettingsButton,
    humanizeError,
    invalidate,
    SegmentedControl,
    SelectInput,
    TextInput
} from 'deveye-sdk-client';
import {
    DEPLOY_TARGET_NAME_MAX_LENGTH,
    type DeployCandidate,
    type DeployCredential,
    type DeployTarget,
    type DeployTargetKind
} from '../contracts/domain';

import { api } from './api';
import { DOKPLOY_TIMEOUT_MS } from './format';
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
 * Les deux genres de cible, tous deux visibles : deux choix fixes, un
 * segment chacun plutôt qu'un déroulant qui les cacherait derrière un clic.
 */
const KIND_OPTIONS: readonly { value: DeployTargetKind; label: string; title: string }[] = [
    { value: 'application', label: 'Application', title: 'Une application Dokploy (application.deploy)' },
    { value: 'compose', label: 'Pile compose', title: 'Une pile Docker Compose (compose.deploy)' }
];

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
 *
 * Les accès se gèrent dans Réglages → Sources, jamais ici : le « + » du
 * sélecteur est le bouton commun de la coquille, ouvert sur cet onglet, et
 * l'accès créé pendant ce temps est adopté à la fermeture. Le dialogue
 * montait lui-même `FeatureSettingsDialog` par un chemin interne de l'app :
 * c'était la dette de coquille de la feature, réglée par son rapatriement.
 */
export function TargetDialog({ open, target, onClose, onSaved, onRemoved }: TargetDialogProps) {
    const [credentials, setCredentials] = useState<DeployCredential[] | null>(null);
    const [credentialId, setCredentialId] = useState('');
    const [candidates, setCandidates] = useState<DeployCandidate[]>([]);
    const [externalId, setExternalId] = useState('');
    const [name, setName] = useState('');
    const [kind, setKind] = useState<DeployTargetKind>('application');
    const [busy, setBusy] = useState(false);
    const [loadingCandidates, setLoadingCandidates] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmRemove, setConfirmRemove] = useState(false);
    /**
     * Les accès connus au moment d'ouvrir les réglages : celui qui apparaît
     * ensuite vient d'y être créé, et c'est pour cette cible-ci ; il se
     * sélectionne donc tout seul au retour.
     */
    const knownIds = useRef<Set<number> | null>(null);

    const reloadCredentials = useCallback(async (): Promise<DeployCredential[]> => {
        try {
            const res = await api.send('deploy.credentialList', {});
            setCredentials(res.credentials);
            return res.credentials;
        } catch (e) {
            setCredentials([]);
            setError(humanizeError(e, 'Impossible de charger les accès de l’espace.'));
            return [];
        }
    }, []);

    useEffect(() => {
        if (!open) return;
        setExternalId(target?.externalId ?? '');
        setName(target?.name ?? '');
        setKind(target?.kind ?? 'application');
        setConfirmRemove(false);
        knownIds.current = null;
        setError(null);
        void reloadCredentials().then((list) => {
            setCredentialId(target?.credentialId ? String(target.credentialId) : String(list[0]?.id ?? ''));
        });
    }, [open, target, reloadCredentials]);

    /**
     * La coquille s'ouvre : on photographie les accès connus. Elle se ferme :
     * relire les accès, adopter celui qui vient de naître. `knownIds` n'est
     * posé qu'à l'ouverture, donc le `false` que le bouton émet au montage et
     * au démontage ne relit rien.
     */
    const onSettingsOpenChange = (opened: boolean) => {
        if (opened) {
            knownIds.current = new Set((credentials ?? []).map((c) => c.id));
            return;
        }
        if (knownIds.current === null) return;
        void reloadCredentials().then((list) => {
            const fresh = list.find((c) => !knownIds.current?.has(c.id));
            knownIds.current = null;
            if (fresh) setCredentialId(String(fresh.id));
            else if (!credentialId && list[0]) setCredentialId(String(list[0].id));
        });
    };

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
                const res = await api.send(
                    'deploy.candidates',
                    { credentialId: Number(credentialId) },
                    { timeoutMs: DOKPLOY_TIMEOUT_MS }
                );
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
        setName((candidate.path ? `${candidate.path} | ` : '') + candidate.name);
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
                ? await api.send('deploy.update', {
                      targetId: target.id,
                      credentialId: Number(credentialId),
                      ...payload
                  })
                : await api.send('deploy.add', { credentialId: Number(credentialId), ...payload });
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
            await api.send('deploy.remove', { targetId: target.id });
            invalidate('deploy.list', 'deploy.count', 'projects.board');
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
                    <>
                        <p className={styles.hint}>
                            Aucun accès Dokploy dans cet espace. Déclarez-en un (adresse de l’instance + clé d’API) : il
                            sera sélectionné ici à votre retour.
                        </p>
                        <div>
                            {/* Le bouton commun, ouvert sur l'onglet Sources :
                                la seule porte vers les accès, ici comme dans
                                l'en-tête de la feature. */}
                            <FeatureSettingsButton
                                scope={{ kind: 'feature', feature: 'deploy' }}
                                initialSection='sources'
                                label='Déclarer un accès Dokploy'
                                onOpenChange={onSettingsOpenChange}
                            />
                        </div>
                    </>
                ) : (
                    <>
                        <label className={styles.field}>
                            <span className={styles.label}>Instance Dokploy</span>
                            <div className={styles.fieldWithAction}>
                                <SelectInput value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
                                    {(credentials ?? []).map((c) => (
                                        <option key={c.id} value={c.id}>
                                            {c.label} — {c.baseUrl}
                                        </option>
                                    ))}
                                </SelectInput>
                                {/* Le « + » : les accès se gèrent dans Réglages →
                                    Sources, jamais ici. Le bouton commun ouvre
                                    donc ces réglages par-dessus, et l'accès créé
                                    est adopté au retour (`onOpenChange` fige la
                                    liste connue à l'ouverture). */}
                                <FeatureSettingsButton
                                    scope={{ kind: 'feature', feature: 'deploy' }}
                                    initialSection='sources'
                                    variant='ghost'
                                    label='Accès Dokploy'
                                    onOpenChange={onSettingsOpenChange}
                                />
                            </div>
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
                                        {c.path ? `${c.path} | ` : ''}
                                        {c.name}
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

                        <div className={styles.field}>
                            <span className={styles.label}>Type</span>
                            <SegmentedControl
                                value={kind}
                                options={KIND_OPTIONS}
                                onChange={setKind}
                                aria-label='Type de cible'
                            />
                            <span className={styles.hint}>
                                Les deux ne se déclenchent pas par la même procédure : une cible du mauvais type reste
                                indéployable.
                            </span>
                        </div>

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
