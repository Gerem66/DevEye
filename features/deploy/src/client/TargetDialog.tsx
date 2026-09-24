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
    DEPLOY_REF_MAX_LENGTH,
    DEPLOY_TARGET_NAME_MAX_LENGTH,
    type DeployCandidate,
    type DeployCredential,
    type DeployTarget,
    type DeployTargetKind
} from '../contracts/domain';

import { api } from './api';
import { DOKPLOY_KIND_OPTIONS, PROVIDER_LABELS, PROVIDER_TIMEOUT_MS, providerError } from './format';
import styles from './style.module.css';

interface TargetDialogProps {
    open: boolean;
    onClose: () => void;
    onSaved: (target: DeployTarget) => void;
}

/**
 * Déclarer une cible de déploiement. Rien d'autre : une fois déclarée, une
 * cible se règle dans l'onglet Général de sa fiche, comme tout élément.
 *
 * Rien ne se crée chez le fournisseur : le dialogue l'interroge pour proposer
 * ce qu'il déclare (applications et piles d'une instance Dokploy, workflows
 * d'un jeton GitHub), avec un repli manuel. Il charge lui-même les
 * accès de l'espace ; ils se gèrent dans Réglages → Sources, et l'accès créé
 * pendant ce temps est adopté à la fermeture.
 */
export function TargetDialog({ open, onClose, onSaved }: TargetDialogProps) {
    const [credentials, setCredentials] = useState<DeployCredential[] | null>(null);
    const [credentialId, setCredentialId] = useState('');
    const [candidates, setCandidates] = useState<DeployCandidate[]>([]);
    const [externalId, setExternalId] = useState('');
    const [name, setName] = useState('');
    const [kind, setKind] = useState<DeployTargetKind>('application');
    const [ref, setRef] = useState('');
    const [busy, setBusy] = useState(false);
    const [loadingCandidates, setLoadingCandidates] = useState(false);
    const [error, setError] = useState<string | null>(null);
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

    const credential = (credentials ?? []).find((c) => String(c.id) === credentialId) ?? null;
    const github = credential?.provider === 'github';

    useEffect(() => {
        if (!open) return;
        setExternalId('');
        setName('');
        setRef('');
        knownIds.current = null;
        setError(null);
        void reloadCredentials().then((list) => {
            setCredentialId(String(list[0]?.id ?? ''));
        });
    }, [open, reloadCredentials]);

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
     * Ce que l'accès propose, chargé dès qu'un accès est désigné.
     * `busy` reste au dépôt du formulaire : une interrogation en cours ne doit
     * pas se lire comme un enregistrement en cours.
     */
    useEffect(() => {
        if (!open || !credentialId) {
            setCandidates([]);
            return;
        }
        let alive = true;
        setLoadingCandidates(true);
        setCandidates([]);
        setExternalId('');
        setRef('');
        // Le type suit l'accès : un workflow chez GitHub, une application par
        // défaut chez Dokploy.
        setKind(github ? 'workflow' : 'application');
        void (async () => {
            try {
                const res = await api.send(
                    'deploy.candidates',
                    { credentialId: Number(credentialId) },
                    { timeoutMs: PROVIDER_TIMEOUT_MS }
                );
                // Une réponse d'un accès qu'on ne regarde plus n'a rien à dire :
                // en changer avant qu'elle n'arrive est courant.
                if (!alive) return;
                setCandidates(res.candidates);
                setError(null);
            } catch (e) {
                // Un fournisseur injoignable n'empêche pas de déclarer la cible :
                // le repli manuel reste ouvert.
                if (alive) setError(providerError(e, 'Impossible de joindre le fournisseur.'));
            } finally {
                if (alive) setLoadingCandidates(false);
            }
        })();
        return () => {
            alive = false;
        };
    }, [open, credentialId, github]);

    /** Choisir dans la liste remplit tout le reste : type, identifiant, nom, branche. */
    const pick = (chosen: string) => {
        setExternalId(chosen);
        const candidate = candidates.find((c) => c.externalId === chosen);
        if (!candidate) return;
        setKind(candidate.kind);
        setRef(candidate.ref ?? '');
        setName((candidate.path ? `${candidate.path} | ` : '') + candidate.name);
    };

    const submit = async () => {
        if (busy || !credentialId || !externalId.trim()) return;
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('deploy.add', {
                credentialId: Number(credentialId),
                kind,
                externalId: externalId.trim(),
                // Un nom laissé vide retombe sur l'identifiant : une cible sans
                // intitulé resterait désignable, mais illisible dans une liste.
                name: name.trim() || externalId.trim(),
                // Une branche vide : celle par défaut du dépôt, lue au déclenchement.
                ref: kind === 'workflow' ? ref.trim() || null : null
            });
            // `deploy.detail` aussi : déclarer une cible déjà connue (idempotence)
            // met à jour son intitulé, que sa fiche peut montrer.
            invalidate('deploy.list', 'deploy.count', 'deploy.detail');
            onSaved(res.target);
        } catch (e) {
            setError(humanizeError(e, 'L’enregistrement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    /** Aucun accès : rien n'est déployable tant qu'il n'y en a pas un. */
    const nothingToUse = credentials !== null && credentials.length === 0;

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Déclarer une cible de déploiement'
            width={560}
            onSubmit={submit}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={submit} disabled={busy || nothingToUse || !externalId.trim()}>
                        {busy ? 'Enregistrement…' : 'Déclarer'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                {nothingToUse ? (
                    <>
                        <p className={styles.hint}>
                            Aucun accès dans cet espace. Déclarez une instance Dokploy (adresse + clé d’API) ou un jeton
                            GitHub : il sera sélectionné ici à votre retour.
                        </p>
                        <div>
                            {/* Le bouton commun, ouvert sur l'onglet Sources : la
                                seule porte vers les accès. */}
                            <FeatureSettingsButton
                                scope={{ kind: 'feature', feature: 'deploy' }}
                                initialSection='sources'
                                label='Déclarer un accès'
                                onOpenChange={onSettingsOpenChange}
                            />
                        </div>
                    </>
                ) : (
                    <>
                        <label className={styles.field}>
                            <span className={styles.label}>Accès</span>
                            <div className={styles.fieldWithAction}>
                                <SelectInput value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
                                    {(credentials ?? []).map((c) => (
                                        <option key={c.id} value={c.id}>
                                            {c.label} · {c.provider === 'github' ? PROVIDER_LABELS.github : c.baseUrl}
                                        </option>
                                    ))}
                                </SelectInput>
                                {/* Le « + » ouvre Réglages → Sources par-dessus ;
                                    l'accès créé est adopté au retour. */}
                                <FeatureSettingsButton
                                    scope={{ kind: 'feature', feature: 'deploy' }}
                                    initialSection='sources'
                                    variant='ghost'
                                    label='Accès'
                                    onOpenChange={onSettingsOpenChange}
                                />
                            </div>
                        </label>

                        {/* Toujours présent, y compris vide : l'afficher seulement
                            une fois rempli déplacerait le formulaire sous les
                            yeux. Sa première ligne porte son état. */}
                        <label className={styles.field}>
                            <span className={styles.label}>Cible</span>
                            <SelectInput
                                value={externalId}
                                onChange={(e) => pick(e.target.value)}
                                disabled={loadingCandidates || candidates.length === 0}
                            >
                                <option value=''>
                                    {loadingCandidates
                                        ? 'Interrogation du fournisseur…'
                                        : candidates.length === 0
                                          ? github
                                              ? 'Ce jeton ne donne accès à aucun workflow'
                                              : 'Cette instance ne déclare aucune application'
                                          : 'Choisir…'}
                                </option>
                                {/* Un identifiant saisi à la main, absent de la
                                    liste : sans cette entrée, le sélecteur
                                    afficherait « Choisir… ». */}
                                {externalId !== '' && !candidates.some((c) => c.externalId === externalId) && (
                                    <option value={externalId}>{externalId} (hors liste)</option>
                                )}
                                {candidates.map((c) => (
                                    <option key={`${c.kind}:${c.externalId}`} value={c.externalId}>
                                        {c.kind === 'compose' ? '🧩 ' : c.kind === 'workflow' ? '⚙️ ' : '📦 '}
                                        {c.path ? `${c.path} | ` : ''}
                                        {c.name}
                                    </option>
                                ))}
                            </SelectInput>
                        </label>

                        {/* Repli manuel, pour une réponse que le décodeur ne
                            reconnaît pas. */}
                        <label className={styles.field}>
                            <span className={styles.label}>…ou identifiant de cible</span>
                            <TextInput
                                value={externalId}
                                placeholder={github ? 'propriétaire/dépôt#identifiant' : 'applicationId ou composeId'}
                                onChange={(e) => setExternalId(e.target.value)}
                            />
                        </label>

                        {github ? (
                            <label className={styles.field}>
                                <span className={styles.label}>Branche</span>
                                <TextInput
                                    value={ref}
                                    maxLength={DEPLOY_REF_MAX_LENGTH}
                                    placeholder='Celle par défaut du dépôt'
                                    onChange={(e) => setRef(e.target.value)}
                                />
                                <span className={styles.hint}>
                                    Le workflow se lance sur cette branche, et l’historique ne montre que ses
                                    exécutions.
                                </span>
                            </label>
                        ) : (
                            <div className={styles.field}>
                                <span className={styles.label}>Type</span>
                                <SegmentedControl
                                    value={kind}
                                    options={DOKPLOY_KIND_OPTIONS}
                                    onChange={setKind}
                                    aria-label='Type de cible'
                                />
                                <span className={styles.hint}>
                                    Les deux ne se déclenchent pas par la même procédure : une cible du mauvais type
                                    reste indéployable.
                                </span>
                            </div>
                        )}

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
            </div>
        </Dialog>
    );
}

export default TargetDialog;
