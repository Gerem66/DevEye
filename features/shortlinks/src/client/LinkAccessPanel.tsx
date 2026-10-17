import {
    errorNote,
    ErrorNote,
    invalidate,
    NumberInput,
    ReadOnlyNotice,
    SaveButton,
    SegmentedControl,
    settingsStyles as shell,
    Switch,
    TextInput,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import { useEffect, useState } from 'react';

import {
    SHORTLINK_MAX_VISITS_MAX,
    SHORTLINK_PASSWORD_MAX,
    SHORTLINK_PASSWORD_MIN,
    type Shortlink
} from '../contracts/domain';
import { api } from './api';
import { endOfLocalDay, formatCount, localDateOf, plural } from './format';
import styles from './style.module.css';

type PasswordMode = 'keep' | 'set' | 'clear';

interface Draft {
    mode: PasswordMode;
    password: string;
    expires: boolean;
    date: string;
    limited: boolean;
    maxVisits: number | null;
}

function draftOf(link: Shortlink): Draft {
    return {
        mode: 'keep',
        password: '',
        expires: link.expiresAt !== null,
        date: localDateOf(link.expiresAt),
        limited: link.maxVisits !== null,
        maxVisits: link.maxVisits
    };
}

/**
 * Qui peut suivre le lien, et jusqu'à quand : un mot de passe que le visiteur
 * tape sur une petite page, une date de fin, un nombre de visites. Passé l'une
 * ou l'autre limite, le lien expire sans rien perdre ; la repousser le rouvre.
 */
export default function LinkAccessPanel({ scope, canWrite }: SettingsPanelProps) {
    const linkId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const [link, setLink] = useState<Shortlink | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);

    useEffect(() => {
        if (linkId === null) return;
        let live = true;
        api.send('shortlinks.get', { id: linkId })
            .then((res) => {
                if (!live) return;
                setLink(res.link);
                setDraft(draftOf(res.link));
            })
            .catch((failure: unknown) => {
                if (live) setError(errorNote(failure, 'Le lien n’a pas pu être lu.'));
            });
        return () => {
            live = false;
        };
    }, [linkId]);

    if (link === null || draft === null) {
        return error ? <ErrorNote note={error} /> : <p className={shell.empty}>Chargement…</p>;
    }

    if (link.foreign) {
        return (
            <p className={shell.sectionHint}>
                Ce lien vient d’un autre espace : son mot de passe et sa fin se règlent depuis là-bas.
            </p>
        );
    }

    const set = (change: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...change } : current));
    const editable = canWrite && !busy;

    const passwordInvalid =
        draft.mode === 'set' &&
        (draft.password.length < SHORTLINK_PASSWORD_MIN || draft.password.length > SHORTLINK_PASSWORD_MAX);
    const sameDay = link.expiresAt !== null && draft.date === localDateOf(link.expiresAt);
    const expiresAt = !draft.expires ? null : sameDay ? link.expiresAt : endOfLocalDay(draft.date);
    const dateInvalid = draft.expires && expiresAt === null;
    const datePast = expiresAt !== null && expiresAt * 1000 < Date.now();
    const visitsInvalid = draft.limited && draft.maxVisits === null;
    const visitsReached = draft.limited && draft.maxVisits !== null && draft.maxVisits <= link.visits;
    const invalid = passwordInvalid || dateInvalid || visitsInvalid;

    const base = draftOf(link);
    const unchanged =
        draft.mode === 'keep' &&
        draft.expires === base.expires &&
        (!draft.expires || draft.date === base.date) &&
        draft.limited === base.limited &&
        (!draft.limited || draft.maxVisits === base.maxVisits);

    const save = async () => {
        if (invalid) throw new Error('invalid');
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('shortlinks.updateAccess', {
                id: link.id,
                access: {
                    password:
                        draft.mode === 'set'
                            ? { mode: 'set', value: draft.password }
                            : draft.mode === 'clear'
                              ? { mode: 'clear' }
                              : { mode: 'keep' },
                    expiresAt,
                    maxVisits: draft.limited ? draft.maxVisits : null
                }
            });
            setLink(res.link);
            setDraft(draftOf(res.link));
            invalidate('shortlinks.list', 'shortlinks.get', 'shortlinks.count');
        } catch (failure) {
            setError(errorNote(failure, 'L’enregistrement a échoué.'));
            throw failure;
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={shell.section}>
            {link.status === 'expired' && (
                <p className={shell.warning}>
                    Ce lien a expiré : repoussez sa date de fin ou relevez son nombre de visites pour le rouvrir.
                </p>
            )}

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Mot de passe</span>
                <SegmentedControl<PasswordMode>
                    value={draft.mode}
                    disabled={!editable}
                    aria-label='Mot de passe'
                    options={
                        link.hasPassword
                            ? [
                                  { value: 'keep', label: 'Garder l’actuel' },
                                  { value: 'set', label: 'Le changer' },
                                  { value: 'clear', label: 'Le retirer' }
                              ]
                            : [
                                  { value: 'keep', label: 'Aucun' },
                                  { value: 'set', label: 'Avec mot de passe' }
                              ]
                    }
                    onChange={(mode) => set({ mode, password: '' })}
                />
                <span className={shell.fieldHint}>
                    {draft.mode === 'clear'
                        ? 'Le lien s’ouvrira de nouveau sans rien demander.'
                        : link.hasPassword || draft.mode === 'set'
                          ? 'Le visiteur le tape sur une petite page avant d’être redirigé.'
                          : 'Tout le monde peut suivre le lien.'}
                </span>
                {draft.mode === 'set' && (
                    <>
                        <label className={shell.fieldLabel} htmlFor='shortlinks-access-password'>
                            {link.hasPassword ? 'Nouveau mot de passe' : 'Mot de passe'}
                        </label>
                        <TextInput
                            id='shortlinks-access-password'
                            type='password'
                            autoComplete='new-password'
                            enableShowHideButton
                            value={draft.password}
                            maxLength={SHORTLINK_PASSWORD_MAX}
                            disabled={!editable}
                            aria-invalid={passwordInvalid && draft.password.length > 0}
                            onChange={(event) => set({ password: event.target.value })}
                        />
                        <span
                            className={passwordInvalid && draft.password.length > 0 ? shell.errorText : shell.fieldHint}
                        >
                            {`${SHORTLINK_PASSWORD_MIN} caractères au moins. Donnez-le aux personnes à qui vous envoyez le lien.`}
                        </span>
                    </>
                )}
            </div>

            <div className={shell.field}>
                <Switch
                    checked={draft.expires}
                    disabled={!editable}
                    label='Fermer le lien à une date'
                    hint='Après ce jour, le lien ne redirige plus. Rien n’est supprimé.'
                    onChange={(expires) => set({ expires })}
                />
                {draft.expires && (
                    <div className={styles.indented}>
                        <label className={shell.fieldLabel} htmlFor='shortlinks-access-date'>
                            Dernier jour
                        </label>
                        <TextInput
                            id='shortlinks-access-date'
                            type='date'
                            value={draft.date}
                            disabled={!editable}
                            aria-invalid={dateInvalid}
                            onChange={(event) => set({ date: event.target.value })}
                        />
                        <span className={dateInvalid ? shell.errorText : datePast ? shell.warning : shell.fieldHint}>
                            {dateInvalid
                                ? 'Choisissez un jour.'
                                : datePast
                                  ? 'Ce jour est passé : le lien ne redirigera plus.'
                                  : 'Le lien se ferme à minuit, à la fin de ce jour, à l’heure de votre appareil.'}
                        </span>
                    </div>
                )}
            </div>

            <div className={shell.field}>
                <Switch
                    checked={draft.limited}
                    disabled={!editable}
                    label='Fermer le lien après un nombre de visites'
                    hint={`Une visite, c’est une personne par jour. Ce lien en compte ${formatCount(link.visits)} à ce jour.`}
                    onChange={(limited) =>
                        set({ limited, maxVisits: draft.maxVisits ?? Math.max(link.visits + 100, 100) })
                    }
                />
                {draft.limited && (
                    <div className={styles.indented}>
                        <label className={shell.fieldLabel} htmlFor='shortlinks-access-visits'>
                            Visites au plus
                        </label>
                        <NumberInput
                            id='shortlinks-access-visits'
                            value={draft.maxVisits}
                            min={1}
                            max={SHORTLINK_MAX_VISITS_MAX}
                            disabled={!editable}
                            onChange={(maxVisits) => set({ maxVisits })}
                        />
                        <span
                            className={
                                visitsInvalid ? shell.errorText : visitsReached ? shell.warning : shell.fieldHint
                            }
                        >
                            {visitsInvalid
                                ? 'Indiquez un nombre de visites.'
                                : visitsReached
                                  ? 'Ce nombre est déjà atteint : le lien ne redirigera plus.'
                                  : `Encore ${plural((draft.maxVisits ?? 0) - link.visits, 'visite', 'visites')} avant qu’il se ferme.`}
                        </span>
                    </div>
                )}
            </div>

            {canWrite ? (
                <SaveButton onSave={save} disabled={busy || unchanged || invalid} />
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier un lien : cela relève de l’écriture sur Liens courts.
                </ReadOnlyNotice>
            )}

            <ErrorNote note={error} />
        </div>
    );
}
