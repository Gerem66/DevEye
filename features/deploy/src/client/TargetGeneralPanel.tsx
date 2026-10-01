import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Button,
    ConfirmDialog,
    FeatureSettingsButton,
    humanizeError,
    invalidate,
    ReadOnlyNotice,
    SaveButton,
    SearchSelect,
    SegmentedControl,
    settingsStyles as shell,
    TextInput,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
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

/**
 * La cible elle-même : son accès (du même fournisseur), ce qu'elle vise chez
 * lui, son type ou sa branche, son intitulé et sa suppression. L'onglet Général de ses réglages, là où le
 * bouton commun mène. Le dialogue, lui, ne fait plus que DÉCLARER une cible,
 * geste qui n'a pas d'élément à viser.
 *
 * Lue une fois à l'ouverture, jamais resuivie : `deploy.detail` bouge à chaque
 * état vu par le rapprochement de fond, et relire le formulaire à ce rythme
 * effacerait la saisie en cours.
 */
export default function TargetGeneralPanel({ scope, canWrite, gone }: SettingsPanelProps) {
    const targetId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const [target, setTarget] = useState<DeployTarget | null>(null);
    const [credentials, setCredentials] = useState<DeployCredential[]>([]);
    /** `''` = accès retiré depuis : la cible reste, indéployable, et le dit. */
    const [credentialId, setCredentialId] = useState('');
    const [candidates, setCandidates] = useState<DeployCandidate[]>([]);
    const [loadingCandidates, setLoadingCandidates] = useState(false);
    const [externalId, setExternalId] = useState('');
    const [name, setName] = useState('');
    const [kind, setKind] = useState<DeployTargetKind>('application');
    const [ref, setRef] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    /**
     * Les accès connus au moment d'ouvrir les réglages de la feature : celui
     * qui apparaît ensuite vient d'y être créé pour cette cible, et se
     * sélectionne tout seul au retour.
     */
    const knownIds = useRef<Set<number> | null>(null);

    const loadCredentials = useCallback(async (): Promise<DeployCredential[]> => {
        const res = await api.send('deploy.credentialList', {});
        setCredentials(res.credentials);
        return res.credentials;
    }, []);

    useEffect(() => {
        if (targetId === null) return;
        void (async () => {
            try {
                const [res] = await Promise.all([api.send('deploy.get', { targetId }), loadCredentials()]);
                setTarget(res.target);
                setCredentialId(res.target.credentialId === null ? '' : String(res.target.credentialId));
                setExternalId(res.target.externalId);
                setName(res.target.name);
                setKind(res.target.kind);
                setRef(res.target.ref ?? '');
            } catch (e) {
                setError(humanizeError(e, 'La cible n’a pas pu être lue.'));
            }
        })();
    }, [targetId, loadCredentials]);

    /*
     * Ce que l'accès propose, dès qu'il est désigné. `deploy.candidates`
     * exige l'écriture, et l'accès d'une cible étrangère n'est pas d'ici : dans
     * ces deux cas on ne demande rien. `busy` reste à l'enregistrement : une
     * interrogation en cours ne doit pas se lire comme lui.
     */
    const ready = target !== null && !target.foreign;
    // Une cible portée par une machine interroge sa machine, les autres leur accès.
    const deviceId = target?.provider === 'agent' ? target.deviceId : null;
    useEffect(() => {
        const query = deviceId ? { deviceId } : credentialId ? { credentialId: Number(credentialId) } : null;
        if (!canWrite || !ready || query === null) {
            setCandidates([]);
            return;
        }
        let alive = true;
        setLoadingCandidates(true);
        setCandidates([]);
        void (async () => {
            try {
                const res = await api.send('deploy.candidates', query, { timeoutMs: PROVIDER_TIMEOUT_MS });
                // Une réponse d'un accès qu'on ne regarde plus n'a rien à dire :
                // en changer avant qu'elle n'arrive est courant.
                if (!alive) return;
                setCandidates(res.candidates);
                setError(null);
            } catch (e) {
                // Un fournisseur injoignable n'empêche pas de régler la cible :
                // le repli manuel reste ouvert.
                if (alive) setError(providerError(e, 'Impossible de joindre le fournisseur.'));
            } finally {
                if (alive) setLoadingCandidates(false);
            }
        })();
        return () => {
            alive = false;
        };
    }, [canWrite, ready, credentialId, deviceId]);

    /**
     * À l'ouverture on photographie les accès connus, à la fermeture on relit et
     * on adopte le nouveau venu. `knownIds` n'est posé qu'à l'ouverture, donc le
     * `false` que le bouton émet au montage et au démontage ne relit rien.
     */
    const onSettingsOpenChange = (opened: boolean) => {
        if (opened) {
            knownIds.current = new Set(credentials.map((c) => c.id));
            return;
        }
        if (knownIds.current === null) return;
        void loadCredentials()
            .then((list) => {
                const fresh = list.find((c) => !knownIds.current?.has(c.id));
                if (fresh) setCredentialId(String(fresh.id));
            })
            .catch(() => setError('Impossible de relire les accès de l’espace.'))
            .finally(() => {
                knownIds.current = null;
            });
    };

    /** Choisir dans la liste remplit tout le reste : type, identifiant, intitulé, branche. */
    const pick = (chosen: string) => {
        setExternalId(chosen);
        const candidate = candidates.find((c) => c.externalId === chosen);
        if (!candidate) return;
        setKind(candidate.kind);
        setRef(candidate.ref ?? '');
        setName((candidate.path ? `${candidate.path} | ` : '') + candidate.name);
    };

    const save = async () => {
        const onMachine = target?.provider === 'agent';
        if (!target || (!onMachine && !credentialId) || !externalId.trim()) return;
        setError(null);
        try {
            const res = await api.send('deploy.update', {
                targetId: target.id,
                credentialId: onMachine ? null : Number(credentialId),
                kind,
                externalId: externalId.trim(),
                // Un intitulé laissé vide retombe sur l'identifiant : une cible
                // sans nom resterait désignable, mais illisible dans une liste.
                name: name.trim() || externalId.trim(),
                ref: kind === 'workflow' ? ref.trim() || null : null
            });
            setTarget(res.target);
            setExternalId(res.target.externalId);
            setName(res.target.name);
            setKind(res.target.kind);
            setRef(res.target.ref ?? '');
            // La liste, la fiche, et l'onglet du projet qui la déploie.
            invalidate('deploy.list', 'deploy.detail', 'projects.board');
        } catch (e) {
            setError(humanizeError(e, 'L’enregistrement a échoué.'));
            // Relancé : le bouton n'annonce « Enregistré » que sur un succès.
            throw e;
        }
    };

    const remove = async () => {
        if (!target) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('deploy.remove', { targetId: target.id });
            // La fiche s'en va AVANT que la liste ne se relise : relue après
            // coup, elle chercherait une cible qui n'existe plus.
            gone();
            invalidate('deploy.list', 'deploy.count', 'projects.board');
        } catch (e) {
            setError(humanizeError(e, 'La suppression a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    if (!target) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    // Régler une cible exige les clés de SON espace : le serveur refuse depuis
    // une fenêtre qui la projette. Déployer, lui, reste permis depuis la fiche.
    if (target.foreign) {
        return (
            <p className={shell.sectionHint}>
                Cette cible vient d’un autre espace qui la partage ici : son accès, ce qu’elle vise, son intitulé et sa
                suppression se règlent chez elle.
            </p>
        );
    }

    const editable = canWrite && !busy;
    const workflow = target.provider === 'github';
    const onMachine = target.provider === 'agent';
    // Un accès d'un autre fournisseur ne sait pas déployer ce que vise la cible.
    const usable = credentials.filter((c) => c.provider === target.provider);
    const unchanged =
        credentialId === (target.credentialId === null ? '' : String(target.credentialId)) &&
        externalId.trim() === target.externalId &&
        (name.trim() || externalId.trim()) === target.name &&
        kind === target.kind &&
        (ref.trim() || null) === target.ref;
    const complete = (onMachine || credentialId !== '') && externalId.trim() !== '';

    return (
        <div className={shell.section}>
            {onMachine ? (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Machine</span>
                    <span>{target.location}</span>
                    <span className={shell.fieldHint}>
                        Une cible portée par une machine le reste : pour en viser une autre, déclarez une nouvelle
                        cible.
                    </span>
                </div>
            ) : (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Accès {PROVIDER_LABELS[target.provider]}</span>
                    <div className={shell.fieldWithAction}>
                        {/* L'accès retiré : le champ vide dit l'état réel, jusqu'à
                            ce qu'un accès soit choisi. */}
                        <SearchSelect
                            value={credentialId}
                            disabled={!editable}
                            aria-label={`Accès ${PROVIDER_LABELS[target.provider]}`}
                            placeholder='Aucun : accès retiré, déclenchement impossible'
                            options={usable.map((c) => ({
                                value: String(c.id),
                                label: c.label,
                                detail: c.provider === 'github' ? undefined : (c.baseUrl ?? undefined)
                            }))}
                            onChange={setCredentialId}
                        />
                        {/* Le bouton commun ouvre les réglages de la feature par-dessus,
                        et l'accès qui y est créé est adopté au retour. */}
                        {canWrite && (
                            <FeatureSettingsButton
                                scope={{ kind: 'feature', feature: 'deploy' }}
                                initialSection='sources'
                                variant='ghost'
                                label='Accès'
                                onOpenChange={onSettingsOpenChange}
                            />
                        )}
                    </div>
                    <span className={shell.fieldHint}>
                        Les accès se gèrent dans Réglages → Sources et servent à toutes les cibles de l’espace.
                    </span>
                </div>
            )}

            {/* Toujours présent, y compris vide : sa première ligne porte son état. */}
            <div className={shell.field}>
                <span className={shell.sectionLabel}>Cible</span>
                <SearchSelect
                    value={externalId}
                    aria-label='Cible'
                    disabled={!editable || loadingCandidates || candidates.length === 0}
                    onChange={pick}
                    placeholder={
                        loadingCandidates
                            ? onMachine
                                ? 'Interrogation de la machine…'
                                : 'Interrogation du fournisseur…'
                            : candidates.length === 0
                              ? onMachine
                                  ? 'Aucun service compose sur cette machine'
                                  : workflow
                                    ? 'Ce jeton ne donne accès à aucun workflow'
                                    : 'Cette instance ne déclare aucune application'
                              : 'Choisir…'
                    }
                    options={[
                        // La cible réglée mais absente de la liste (retirée chez le
                        // fournisseur, ou saisie à la main) : sans cette entrée, le
                        // sélecteur afficherait « Choisir… ».
                        ...(externalId !== '' && !candidates.some((c) => c.externalId === externalId)
                            ? [{ value: externalId, label: externalId, detail: 'hors liste' }]
                            : []),
                        ...candidates.map((c) => ({
                            value: c.externalId,
                            label: `${c.path ? `${c.path} | ` : ''}${c.name}`,
                            prefix:
                                c.kind === 'compose' || c.kind === 'service'
                                    ? '🧩'
                                    : c.kind === 'workflow'
                                      ? '⚙️'
                                      : '📦'
                        }))
                    ]}
                />
            </div>

            {/* Repli manuel, pour une réponse que le décodeur ne reconnaît pas. */}
            <div className={shell.field}>
                <span className={shell.sectionLabel}>Identifiant de cible</span>
                <TextInput
                    value={externalId}
                    disabled={!editable}
                    placeholder={
                        onMachine
                            ? 'docker/projet/service'
                            : workflow
                              ? 'propriétaire/dépôt#identifiant'
                              : 'applicationId ou composeId'
                    }
                    aria-label='Identifiant de cible'
                    onChange={(e) => setExternalId(e.target.value)}
                />
                <span className={shell.fieldHint}>
                    {onMachine
                        ? 'Moteur, projet et service compose, pour un service que la liste ci-dessus ne propose pas.'
                        : `Tel que ${PROVIDER_LABELS[target.provider]} le nomme, pour une cible que la liste ci-dessus ne propose pas.`}
                </span>
            </div>

            {onMachine ? null : workflow ? (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Branche</span>
                    <TextInput
                        value={ref}
                        disabled={!editable}
                        maxLength={DEPLOY_REF_MAX_LENGTH}
                        placeholder='Celle par défaut du dépôt'
                        aria-label='Branche'
                        onChange={(e) => setRef(e.target.value)}
                    />
                    <span className={shell.fieldHint}>
                        Le workflow se lance sur cette branche, et l’historique ne montre que ses exécutions.
                    </span>
                </div>
            ) : (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Type</span>
                    <SegmentedControl
                        value={kind}
                        options={DOKPLOY_KIND_OPTIONS}
                        disabled={!editable}
                        onChange={setKind}
                        aria-label='Type de cible'
                    />
                    <span className={shell.fieldHint}>
                        Les deux ne se déclenchent pas par la même procédure : une cible du mauvais type reste
                        indéployable.
                    </span>
                </div>
            )}

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Intitulé</span>
                <TextInput
                    value={name}
                    disabled={!editable}
                    maxLength={DEPLOY_TARGET_NAME_MAX_LENGTH}
                    placeholder='Le nom sous lequel vous la reconnaissez'
                    aria-label='Intitulé'
                    onChange={(e) => setName(e.target.value)}
                />
            </div>

            {canWrite ? (
                <SaveButton onSave={save} disabled={busy || unchanged || !complete} />
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier une cible : cela relève de l’écriture sur Déploiement.
                </ReadOnlyNotice>
            )}

            {canWrite && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Supprimer cette cible</span>
                    <span className={shell.fieldHint}>
                        Son historique part avec elle, et les projets qui la déployaient perdent leur liaison. Ce
                        qu’elle vise {onMachine ? 'sur' : 'chez'} {PROVIDER_LABELS[target.provider]} n’est pas touché.
                    </span>
                    <div className={shell.sectionActions}>
                        <Button
                            variant='danger'
                            disabled={busy}
                            onClick={() =>
                                setConfirm({
                                    title: `Supprimer « ${target.name} » ?`,
                                    description: `Son historique est perdu, et les projets qui la déployaient perdent leur liaison. Ce qu’elle vise ${onMachine ? 'sur' : 'chez'} ${PROVIDER_LABELS[target.provider]} n’est pas touché.`,
                                    confirmLabel: 'Supprimer la cible',
                                    onConfirm: () => void remove()
                                })
                            }
                        >
                            Supprimer la cible
                        </Button>
                    </div>
                </div>
            )}

            {error && <p className={shell.notice}>{error}</p>}

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}
