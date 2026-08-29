import { useEffect, useRef, useState } from 'react';
import { FeatureSettingsButton, humanizeError, SelectInput, TextInput } from 'deveye-sdk-client';
import {
    GIT_REPO_NAME_MAX_LENGTH,
    GIT_REPO_OWNER_MAX_LENGTH,
    type GitCredential,
    type GitRepoCandidate
} from '../contracts/domain';

import { api } from './api';
import styles from './style.module.css';

/** Ce que le formulaire décrit à un instant donné. */
export interface RepoTarget {
    owner: string;
    repo: string;
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

/**
 * Désigner un dépôt chez le fournisseur : jeton, propriétaire, puis dépôt.
 *
 * L'ordre des trois champs compte : le jeton vient en premier parce qu'il change
 * le résultat des deux autres, sans lui GitHub ne rend que le public. La liste se
 * recharge donc à chaque changement de jeton ou de propriétaire, et de rien d'autre.
 *
 * La saisie manuelle reste possible : la découverte dépend d'une API tierce qui
 * peut refuser (quota épuisé, propriétaire introuvable, jeton à portée réduite),
 * et un échec de liste ne doit pas empêcher d'ajouter un dépôt qu'on sait nommer.
 */
export function RepoPicker({ credentials, value, onChange, onSettingsOpenChange, autoFocus }: RepoPickerProps) {
    const [candidates, setCandidates] = useState<GitRepoCandidate[] | null>(null);
    const [looking, setLooking] = useState(false);
    const [lookupError, setLookupError] = useState<string | null>(null);
    const [manual, setManual] = useState(false);

    const owner = value.owner.trim();
    const credentialId = value.credentialId;

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

    // Un nom saisi qui ne figure pas dans la liste ne doit pas disparaître du
    // sélecteur : on bascule alors en saisie libre plutôt que de l'effacer.
    const inList = candidates?.some((c) => c.name === value.repo) ?? false;
    const useManual = manual || lookupError !== null || (candidates !== null && candidates.length === 0);

    return (
        <>
            <label className={styles.field}>
                <span className={styles.label}>Jeton d’accès</span>
                <div className={styles.fieldWithAction}>
                    <SelectInput
                        value={credentialId === null ? '' : String(credentialId)}
                        onChange={(e) =>
                            onChange({ ...value, credentialId: e.target.value ? Number(e.target.value) : null })
                        }
                    >
                        <option value=''>Aucun — dépôts publics uniquement</option>
                        {credentials.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.label}
                            </option>
                        ))}
                    </SelectInput>
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
                        : 'Change la liste ci-dessous — un jeton donne accès aux dépôts privés, et il est indispensable à la synchronisation.'}
                </span>
            </label>

            <label className={styles.field}>
                <span className={styles.label}>Propriétaire ou organisation</span>
                <TextInput
                    data-autofocus={autoFocus ? '' : undefined}
                    value={value.owner}
                    placeholder='gerem66'
                    maxLength={GIT_REPO_OWNER_MAX_LENGTH}
                    onChange={(e) => onChange({ ...value, owner: e.target.value })}
                />
            </label>

            <label className={styles.field}>
                <span className={styles.label}>Dépôt</span>

                {!useManual && (
                    <SelectInput
                        value={inList ? value.repo : ''}
                        disabled={owner.length === 0 || looking || candidates === null}
                        onChange={(e) => onChange({ ...value, repo: e.target.value })}
                    >
                        <option value=''>
                            {owner.length === 0
                                ? 'Saisissez d’abord un propriétaire'
                                : looking
                                  ? 'Lecture chez GitHub…'
                                  : `Choisir parmi ${candidates?.length ?? 0} dépôt${(candidates?.length ?? 0) > 1 ? 's' : ''}…`}
                        </option>
                        {candidates?.map((c) => (
                            <option key={c.name} value={c.name}>
                                {c.name}
                                {c.private && ' · privé'}
                                {c.archived && ' · archivé'}
                                {c.known && ' · déjà dans l’espace'}
                            </option>
                        ))}
                    </SelectInput>
                )}

                {useManual && (
                    <TextInput
                        value={value.repo}
                        placeholder='DevEye'
                        maxLength={GIT_REPO_NAME_MAX_LENGTH}
                        onChange={(e) => onChange({ ...value, repo: e.target.value })}
                    />
                )}

                {lookupError && <span className={styles.lookupError}>{lookupError}</span>}

                {candidates !== null && candidates.length === 0 && !lookupError && (
                    <span className={styles.hint}>
                        Aucun dépôt visible pour « {owner} »
                        {credentialId === null && ' — un jeton révélerait peut-être des dépôts privés'}.
                    </span>
                )}

                {/* Le retour à la liste n'est proposé que si elle a quelque chose
                    à montrer, sinon le bouton mènerait à un cul-de-sac. */}
                {(!useManual || manual) && (
                    <button type='button' className={styles.linkButton} onClick={() => setManual((v) => !v)}>
                        {manual && candidates !== null && candidates.length > 0
                            ? 'Choisir dans la liste'
                            : 'Saisir le nom à la main'}
                    </button>
                )}
            </label>
        </>
    );
}

export default RepoPicker;
