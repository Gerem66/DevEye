import { useEffect, useRef, useState } from 'react';
import { FeatureSettingsButton, humanizeError, SearchSelect, TextInput } from 'deveye-sdk-client';
import {
    GIT_REPO_OWNER_MAX_LENGTH,
    type GitCredential,
    type GitOwnerCandidate,
    type GitRepoCandidate
} from '../contracts/domain';

import { api } from './api';
import styles from './style.module.css';

/** Ce que le formulaire décrit à un instant donné. */
export interface RepoTarget {
    owner: string;
    /** Plusieurs cochés dans la liste, un seul en saisie à la main. */
    repos: string[];
    credentialId: number | null;
}

interface RepoPickerProps {
    /** Les jetons de l'espace, lus par le dialogue qui monte ce sélecteur. */
    credentials: readonly GitCredential[];
    value: RepoTarget;
    onChange: (value: RepoTarget) => void;
    /**
     * Le « + » du sélecteur ouvre et referme les réglages ; l'appelant en profite
     * pour relire ses jetons et adopter celui qui vient d'être créé.
     */
    onSettingsOpenChange: (open: boolean) => void;
    autoFocus?: boolean;
}

/**
 * Attente avant d'interroger GitHub sur un propriétaire en cours de frappe : assez
 * long pour ne pas lancer un appel par lettre, assez court pour qu'on ne l'attende pas.
 */
const LOOKUP_DEBOUNCE_MS = 500;

/** Ce qui distingue un dépôt dans la liste : privé, archivé, déjà suivi. */
function candidateDetail(c: GitRepoCandidate): string | undefined {
    const marks = [c.private && 'privé', c.archived && 'archivé', c.known && 'déjà dans l’espace'].filter(Boolean);
    return marks.length > 0 ? marks.join(' · ') : undefined;
}

/** Les noms d'une saisie libre : séparés par des virgules, espaces libres autour. */
function splitNames(text: string): string[] {
    return text
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '');
}

/**
 * Désigner des dépôts chez le fournisseur : jeton, propriétaire, puis dépôts.
 *
 * L'ordre des trois champs compte : le jeton vient en premier parce qu'il change
 * le résultat des deux autres, sans lui GitHub ne rend que le public. La liste se
 * recharge donc à chaque changement de jeton ou de propriétaire, et de rien d'autre.
 *
 * La saisie manuelle reste possible : la découverte dépend d'une API tierce qui
 * peut refuser (quota épuisé, propriétaire introuvable, jeton à portée réduite),
 * et un échec de liste ne doit pas empêcher d'ajouter un dépôt qu'on sait nommer.
 * Il en va de même du propriétaire, proposé parmi les comptes du jeton.
 */
export function RepoPicker({ credentials, value, onChange, onSettingsOpenChange, autoFocus }: RepoPickerProps) {
    const [candidates, setCandidates] = useState<GitRepoCandidate[] | null>(null);
    const [looking, setLooking] = useState(false);
    const [lookupError, setLookupError] = useState<string | null>(null);
    const [manual, setManual] = useState(false);
    /** Le texte de la saisie libre, gardé tel quel : le reformater à chaque frappe déplacerait le curseur. */
    const [manualText, setManualText] = useState('');
    const [owners, setOwners] = useState<GitOwnerCandidate[] | null>(null);
    const [ownersError, setOwnersError] = useState<string | null>(null);
    const [ownerManual, setOwnerManual] = useState(false);

    const owner = value.owner.trim();
    const credentialId = value.credentialId;

    useEffect(() => {
        setOwners(null);
        setOwnersError(null);
        if (credentialId === null) return;
        let alive = true;
        api.send('git.ownerCandidates', { credentialId })
            .then((res) => {
                if (alive) setOwners(res.owners);
            })
            .catch((e) => {
                if (alive) setOwnersError(humanizeError(e, 'Les comptes de ce jeton n’ont pas pu être listés.'));
            });
        return () => {
            alive = false;
        };
    }, [credentialId]);

    const ownerList = credentialId !== null && !ownerManual && ownersError === null && owners?.length !== 0;

    // Un propriétaire que le nouveau jeton n'atteint pas laisse place au compte du jeton.
    useEffect(() => {
        if (!ownerList || owners === null || owners.some((o) => o.login === value.owner)) return;
        onChange({ ...value, owner: owners[0].login, repos: [] });
    }, [owners, ownerList]);

    /**
     * Le jeton d'une réponse en vol : sans lui, une recherche lente sur « ger »
     * écraserait le résultat de « gerem66 » en arrivant après.
     */
    const runId = useRef(0);

    useEffect(() => {
        if (owner.length === 0) {
            setCandidates(null);
            setLookupError(null);
            setLooking(false);
            return;
        }

        const id = ++runId.current;
        setLooking(true);
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const res = await api.send('git.repoCandidates', { owner, credentialId });
                    if (runId.current !== id) return;
                    setCandidates(res.repos);
                    setLookupError(null);
                } catch (e) {
                    if (runId.current !== id) return;
                    setCandidates(null);
                    setLookupError(humanizeError(e, 'Les dépôts n’ont pas pu être listés.'));
                } finally {
                    if (runId.current === id) setLooking(false);
                }
            })();
        }, LOOKUP_DEBOUNCE_MS);

        return () => clearTimeout(timer);
    }, [owner, credentialId]);

    const useManual = manual || lookupError !== null || (candidates !== null && candidates.length === 0);
    /** Un autre jeton ou un autre propriétaire relit la liste : les cases cochées dans l'ancienne tombent. */
    const kept = useManual ? value.repos : [];

    // Le texte suit la sélection venue d'ailleurs (la liste quittée, les seuls refusés d'un ajout).
    useEffect(() => {
        if (useManual && splitNames(manualText).join(',') !== value.repos.join(',')) {
            setManualText(value.repos.join(','));
        }
    }, [useManual, value.repos]);

    // Un nom tapé pendant que la liste manquait ne doit pas partir caché quand elle revient.
    useEffect(() => {
        if (useManual || candidates === null) return;
        const visible = value.repos.filter((name) => candidates.some((c) => c.name === name));
        if (visible.length !== value.repos.length) onChange({ ...value, repos: visible });
    }, [candidates, useManual]);

    return (
        <>
            <label className={styles.field}>
                <span className={styles.label}>Jeton d’accès</span>
                <div className={styles.fieldWithAction}>
                    <SearchSelect
                        value={credentialId === null ? '' : String(credentialId)}
                        aria-label='Jeton d’accès'
                        options={[
                            { value: '', label: 'Aucun : dépôts publics uniquement' },
                            ...credentials.map((c) => ({ value: String(c.id), label: c.label }))
                        ]}
                        onChange={(v) => onChange({ ...value, repos: kept, credentialId: v ? Number(v) : null })}
                    />
                    {/* Le bouton commun, ouvert sur l'onglet Sources : la seule
                        porte vers les jetons, ici comme ailleurs. */}
                    <FeatureSettingsButton
                        scope={{ kind: 'feature', feature: 'git' }}
                        initialSection='sources'
                        variant='ghost'
                        label='Jetons GitHub'
                        onOpenChange={onSettingsOpenChange}
                    />
                </div>
                <span className={styles.hint}>
                    {credentials.length === 0
                        ? 'Aucun jeton GitHub enregistré : seuls les dépôts publics apparaîtront, et la synchronisation restera inactive. « Jetons GitHub » ouvre les réglages pour en déclarer un.'
                        : 'Change la liste ci-dessous : un jeton donne accès aux dépôts privés, et il est indispensable à la synchronisation.'}
                </span>
            </label>

            <label className={styles.field}>
                <span className={styles.label}>Propriétaire ou organisation</span>
                {ownerList ? (
                    <SearchSelect
                        autoFocus={autoFocus}
                        value={value.owner}
                        aria-label='Propriétaire ou organisation'
                        disabled={owners === null}
                        placeholder={owners === null ? 'Lecture des comptes du jeton…' : 'Choisir…'}
                        options={(owners ?? []).map((o) => ({
                            value: o.login,
                            label: o.login,
                            detail: o.kind === 'self' ? 'compte du jeton' : 'organisation'
                        }))}
                        onChange={(login) => onChange({ ...value, repos: kept, owner: login })}
                    />
                ) : (
                    <TextInput
                        data-autofocus={autoFocus ? '' : undefined}
                        value={value.owner}
                        placeholder='gerem66'
                        maxLength={GIT_REPO_OWNER_MAX_LENGTH}
                        onChange={(e) => onChange({ ...value, repos: kept, owner: e.target.value })}
                    />
                )}

                {ownersError && <span className={styles.lookupError}>{ownersError}</span>}

                {/* Sans jeton, aucun compte à proposer : la saisie libre est le seul chemin. */}
                {credentialId !== null && ownersError === null && owners?.length !== 0 && (
                    <button type='button' className={styles.linkButton} onClick={() => setOwnerManual((v) => !v)}>
                        {ownerManual ? 'Choisir dans la liste' : 'Saisir le nom à la main'}
                    </button>
                )}
            </label>

            <label className={styles.field}>
                <span className={styles.label}>Dépôts</span>

                {!useManual && (
                    <SearchSelect
                        multiple
                        value={value.repos.filter((name) => candidates?.some((c) => c.name === name))}
                        aria-label='Dépôts'
                        disabled={owner.length === 0 || looking || candidates === null}
                        placeholder={
                            owner.length === 0
                                ? 'Saisissez d’abord un propriétaire'
                                : looking
                                  ? 'Lecture chez GitHub…'
                                  : `Choisir parmi ${candidates?.length ?? 0} dépôt${(candidates?.length ?? 0) > 1 ? 's' : ''}…`
                        }
                        options={(candidates ?? []).map((c) => ({
                            value: c.name,
                            label: c.name,
                            detail: candidateDetail(c)
                        }))}
                        onChange={(repos) => onChange({ ...value, repos })}
                    />
                )}

                {useManual && (
                    <>
                        <TextInput
                            value={manualText}
                            placeholder='DevEye,DevEye-Types'
                            onChange={(e) => {
                                setManualText(e.target.value);
                                onChange({ ...value, repos: splitNames(e.target.value) });
                            }}
                        />
                        <span className={styles.hint}>Plusieurs dépôts : séparez leurs noms par des virgules.</span>
                    </>
                )}

                {lookupError && <span className={styles.lookupError}>{lookupError}</span>}

                {candidates !== null && candidates.length === 0 && !lookupError && (
                    <span className={styles.hint}>
                        Aucun dépôt visible pour « {owner} »
                        {credentialId === null && ' : un jeton révélerait peut-être des dépôts privés'}.
                    </span>
                )}

                {/* Le retour à la liste n'est proposé que si elle a quelque chose
                    à montrer, sinon le bouton mènerait à un cul-de-sac. */}
                {(!useManual || manual) && (
                    <button type='button' className={styles.linkButton} onClick={() => setManual((v) => !v)}>
                        {manual && candidates !== null && candidates.length > 0
                            ? 'Choisir dans la liste'
                            : 'Saisir les noms à la main'}
                    </button>
                )}
            </label>
        </>
    );
}

export default RepoPicker;
