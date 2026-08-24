import { useEffect, useRef, useState } from 'react';
import type { Credential, GitRepoCandidate } from '@deveye/types';
import { GIT_REPO_NAME_MAX_LENGTH, GIT_REPO_OWNER_MAX_LENGTH } from '@deveye/types';
import { Button, SelectInput, TextInput } from '@/Components';
import { ws } from '@/api/ws';
import { humanizeError } from '../Projects/api';
import styles from './style.module.css';

/** Ce que le formulaire décrit à un instant donné. */
export interface RepoTarget {
    owner: string;
    repo: string;
    credentialId: number | null;
}

interface RepoPickerProps {
    credentials: Credential[];
    value: RepoTarget;
    onChange: (value: RepoTarget) => void;
    /** Ouvre Réglages → Sources : les jetons se gèrent là, jamais ici. */
    onManageCredentials?: () => void;
    autoFocus?: boolean;
}

/**
 * Attente avant d'interroger GitHub sur un propriétaire en cours de frappe.
 *
 * Assez long pour ne pas lancer un appel par lettre (« g », « ge », « ger »…),
 * assez court pour que la liste paraisse arriver seule.
 */
const LOOKUP_DEBOUNCE_MS = 500;

/**
 * Désigner un dépôt chez le fournisseur : jeton, propriétaire, puis dépôt.
 *
 * **L'ordre des trois champs est le sujet.** Le jeton vient en premier parce
 * qu'il *change le résultat* des deux autres : sans lui GitHub ne rend que le
 * public, avec lui il rend aussi les dépôts privés du compte ou de
 * l'organisation. Le placer sous la liste, comme c'était le cas, revenait à
 * demander de choisir dans une liste avant d'avoir dit ce qu'elle devait
 * contenir.
 *
 * La liste se recharge donc à **chaque changement de jeton ou de propriétaire**,
 * et ces deux-là seulement — c'est exactement ce dont elle dépend.
 *
 * La saisie manuelle reste possible et n'est pas un détail : la découverte
 * dépend d'une API tierce qui peut refuser (quota anonyme épuisé, propriétaire
 * introuvable, jeton à portée réduite). Sans repli, un échec de liste
 * empêcherait d'ajouter un dépôt dont on connaît parfaitement le nom.
 */
export function RepoPicker({ credentials, value, onChange, onManageCredentials, autoFocus }: RepoPickerProps) {
    const [candidates, setCandidates] = useState<GitRepoCandidate[] | null>(null);
    const [looking, setLooking] = useState(false);
    const [lookupError, setLookupError] = useState<string | null>(null);
    const [manual, setManual] = useState(false);

    const owner = value.owner.trim();
    const credentialId = value.credentialId;

    /**
     * Le jeton d'une réponse en vol.
     *
     * Sans lui, une recherche lente sur « ger » écraserait le résultat de
     * « gerem66 » en arrivant après — la réponse la plus lente gagnerait la
     * course.
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
                    const res = await ws.send('git.repoCandidates', { owner, credentialId });
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

    const githubCredentials = credentials.filter((c) => c.provider === 'github');
    // Un nom saisi qui ne figure pas dans la liste ne doit pas disparaître du
    // sélecteur : on bascule alors en saisie libre plutôt que de l'effacer.
    const inList = candidates?.some((c) => c.name === value.repo) ?? false;
    const useManual = manual || lookupError !== null || (candidates !== null && candidates.length === 0);

    return (
        <>
            {/* En premier : il décide de ce que les deux champs suivants peuvent
                voir. */}
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
                        {githubCredentials.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.label}
                            </option>
                        ))}
                    </SelectInput>
                    {onManageCredentials && (
                        <Button
                            variant='ghost'
                            icon='plus'
                            aria-label='Gérer les jetons GitHub'
                            title='Gérer les jetons GitHub (Réglages → Sources)'
                            onClick={onManageCredentials}
                        />
                    )}
                </div>
                <span className={styles.hint}>
                    {githubCredentials.length === 0
                        ? 'Aucun jeton GitHub enregistré : seuls les dépôts publics apparaîtront, et la synchronisation restera inactive. Le « + » ouvre les réglages pour en déclarer un.'
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

                {/* Toujours offert : la liste dépend d'une API tierce, et un nom
                    qu'on connaît doit rester saisissable même quand elle échoue.
                    Le retour à la liste n'est proposé que si elle a quelque
                    chose à montrer — sinon le bouton mènerait à un cul-de-sac. */}
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
