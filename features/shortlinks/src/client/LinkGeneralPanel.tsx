import {
    Button,
    Checkbox,
    ConfirmDialog,
    humanizeError,
    invalidate,
    ReadOnlyNotice,
    SaveButton,
    settingsStyles as shell,
    Switch,
    TextInput,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import { useEffect, useState } from 'react';

import { normaliseSlug, SHORTLINK_TITLE_MAX, SHORTLINK_URL_MAX, type Shortlink } from '../contracts/domain';
import AddressFields, { slugValid } from './AddressFields';
import { api } from './api';
import { displayTitle, isHttpUrl } from './format';

interface Draft {
    title: string;
    target: string;
    ios: string;
    android: string;
    domainId: number | null;
    slug: string;
    checkTarget: boolean;
}

function draftOf(link: Shortlink): Draft {
    return {
        title: link.title,
        target: link.targets.default,
        ios: link.targets.ios ?? '',
        android: link.targets.android ?? '',
        domainId: link.domainId,
        slug: link.slug ?? '',
        checkTarget: link.check.enabled
    };
}

const sameDraft = (a: Draft, b: Draft): boolean =>
    (Object.keys(a) as (keyof Draft)[]).every((key) => a[key] === b[key]);

/** Une destination par appareil est facultative : vide, c'est la destination principale. */
const optionalUrlValid = (value: string): boolean => value.trim().length === 0 || isHttpUrl(value.trim());

/**
 * Le lien lui-même : son titre, ses destinations, son adresse, la vérification
 * de sa destination, son interrupteur et sa suppression. L'onglet Général de ses
 * réglages, là où mène le bouton commun.
 */
export default function LinkGeneralPanel({ scope, canWrite, gone }: SettingsPanelProps) {
    const linkId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const [link, setLink] = useState<Shortlink | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [enabled, setEnabled] = useState(true);
    const [toggling, setToggling] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    useEffect(() => {
        if (linkId === null) return;
        let live = true;
        api.send('shortlinks.get', { id: linkId })
            .then((res) => {
                if (!live) return;
                setLink(res.link);
                setDraft(draftOf(res.link));
                setEnabled(res.link.enabled);
            })
            .catch((failure: unknown) => {
                if (live) setError(humanizeError(failure, 'Le lien n’a pas pu être lu.'));
            });
        return () => {
            live = false;
        };
    }, [linkId]);

    if (link === null || draft === null) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    if (link.foreign) {
        return (
            <p className={shell.sectionHint}>
                Ce lien vient d’un autre espace : ses destinations, son adresse et sa suppression se règlent depuis
                là-bas.
            </p>
        );
    }

    const set = (change: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...change } : current));
    const editable = canWrite && !busy;
    const targetInvalid = !isHttpUrl(draft.target.trim());
    const iosInvalid = !optionalUrlValid(draft.ios);
    const androidInvalid = !optionalUrlValid(draft.android);
    const slugInvalid = draft.domainId !== null && !slugValid(draft.slug);
    const invalid = targetInvalid || iosInvalid || androidInvalid || slugInvalid;
    const unchanged = sameDraft(draft, draftOf(link));
    const blocked = link.status === 'blocked';

    const save = async () => {
        if (invalid) throw new Error('invalid');
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('shortlinks.update', {
                id: link.id,
                link: {
                    title: draft.title.trim(),
                    targets: {
                        default: draft.target.trim(),
                        ios: draft.ios.trim() || null,
                        android: draft.android.trim() || null
                    },
                    domainId: draft.domainId,
                    slug: draft.domainId === null ? null : normaliseSlug(draft.slug),
                    checkTarget: draft.checkTarget
                }
            });
            setLink(res.link);
            setDraft(draftOf(res.link));
            invalidate('shortlinks.list', 'shortlinks.get');
        } catch (failure) {
            setError(humanizeError(failure, 'L’enregistrement a échoué.'));
            // Relancé : le bouton n'annonce « Enregistré » que sur un succès.
            throw failure;
        } finally {
            setBusy(false);
        }
    };

    /** Appliqué tout de suite ; un refus du serveur remet l'interrupteur où il était, avec sa raison. */
    const toggle = async (next: boolean) => {
        const before = enabled;
        setEnabled(next);
        setToggling(true);
        setError(null);
        try {
            const res = await api.send('shortlinks.setEnabled', { id: link.id, enabled: next });
            setLink(res.link);
            setEnabled(res.link.enabled);
            invalidate('shortlinks.list', 'shortlinks.get', 'shortlinks.count');
        } catch (failure) {
            setEnabled(before);
            setError(humanizeError(failure, 'Le lien n’a pas pu être changé.'));
        } finally {
            setToggling(false);
        }
    };

    const remove = async () => {
        setBusy(true);
        setError(null);
        try {
            await api.send('shortlinks.remove', { id: link.id });
            // La fiche s'en va AVANT que la liste ne se relise : relue après coup,
            // elle chercherait un lien qui n'existe plus.
            gone();
            invalidate('shortlinks.list', 'shortlinks.count', 'shortlinks.stats');
        } catch (failure) {
            setError(humanizeError(failure, 'La suppression a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={shell.section}>
            <Switch
                checked={enabled}
                disabled={!canWrite || toggling || blocked}
                label='Lien actif'
                hint={
                    blocked
                        ? 'Retiré par l’administration du service : il ne redirige plus, quel que soit ce réglage.'
                        : 'Coupé, le lien ne redirige plus personne. Ses réglages et ses chiffres sont gardés.'
                }
                onChange={(next) => void toggle(next)}
            />

            <div className={shell.field}>
                <label className={shell.sectionLabel} htmlFor='shortlinks-general-title'>
                    Titre
                </label>
                <TextInput
                    id='shortlinks-general-title'
                    value={draft.title}
                    maxLength={SHORTLINK_TITLE_MAX}
                    placeholder={displayTitle({ title: '', targets: link.targets })}
                    disabled={!editable}
                    onChange={(event) => set({ title: event.target.value })}
                />
                <span className={shell.fieldHint}>
                    Pour le reconnaître dans la liste. Les visiteurs ne le voient pas.
                </span>
            </div>

            <div className={shell.field}>
                <label className={shell.sectionLabel} htmlFor='shortlinks-general-target'>
                    Destination
                </label>
                <TextInput
                    id='shortlinks-general-target'
                    type='url'
                    inputMode='url'
                    spellCheck={false}
                    value={draft.target}
                    maxLength={SHORTLINK_URL_MAX}
                    disabled={!editable}
                    aria-invalid={targetInvalid}
                    error={targetInvalid ? 'Une adresse web complète, qui commence par https:// ou http://' : undefined}
                    onChange={(event) => set({ target: event.target.value })}
                />
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Selon l’appareil (facultatif)</span>
                <span className={shell.fieldHint}>
                    Pour envoyer un téléphone vers la bonne boutique d’applications, par exemple. Vide : la destination
                    ci-dessus.
                </span>
                <label className={shell.fieldLabel} htmlFor='shortlinks-general-ios'>
                    Sur iPhone et iPad
                </label>
                <TextInput
                    id='shortlinks-general-ios'
                    type='url'
                    inputMode='url'
                    spellCheck={false}
                    value={draft.ios}
                    maxLength={SHORTLINK_URL_MAX}
                    placeholder='https://apps.apple.com/…'
                    disabled={!editable}
                    aria-invalid={iosInvalid}
                    error={iosInvalid ? 'Une adresse web complète, ou rien' : undefined}
                    onChange={(event) => set({ ios: event.target.value })}
                />
                <label className={shell.fieldLabel} htmlFor='shortlinks-general-android'>
                    Sur Android
                </label>
                <TextInput
                    id='shortlinks-general-android'
                    type='url'
                    inputMode='url'
                    spellCheck={false}
                    value={draft.android}
                    maxLength={SHORTLINK_URL_MAX}
                    placeholder='https://play.google.com/…'
                    disabled={!editable}
                    aria-invalid={androidInvalid}
                    error={androidInvalid ? 'Une adresse web complète, ou rien' : undefined}
                    onChange={(event) => set({ android: event.target.value })}
                />
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Adresse de DevEye</span>
                <span className={shell.fieldLabel}>{link.shortUrl}</span>
                <span className={shell.fieldHint}>Elle ne change jamais et fonctionne toujours, domaine ou non.</span>
            </div>

            <AddressFields
                idPrefix='shortlinks-general'
                domainId={draft.domainId}
                slug={draft.slug}
                keepDomainId={link.domainId}
                labelClassName={shell.sectionLabel}
                disabled={!editable}
                onChange={(next) => set(next)}
            />

            <Checkbox checked={draft.checkTarget} disabled={!editable} onChange={(checkTarget) => set({ checkTarget })}>
                <>
                    <span className={shell.fieldLabel}>Surveiller la destination</span>
                    <span className={shell.fieldHint}>
                        DevEye l’ouvre une fois par jour et vous prévient si elle ne répond plus.
                    </span>
                </>
            </Checkbox>

            {canWrite ? (
                <SaveButton onSave={save} disabled={busy || unchanged || invalid} />
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier un lien : cela relève de l’écriture sur Liens courts.
                </ReadOnlyNotice>
            )}

            {error && <p className={shell.notice}>{error}</p>}

            {canWrite && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Supprimer ce lien</span>
                    <span className={shell.fieldHint}>
                        Ses adresses ne répondent plus, et ses statistiques sont effacées : il n’y a pas d’archive.
                    </span>
                    <div className={shell.sectionActions}>
                        <Button
                            variant='danger'
                            disabled={busy}
                            onClick={() =>
                                setConfirm({
                                    title: `Supprimer « ${displayTitle(link)} » ?`,
                                    description:
                                        'Ses adresses ne répondent plus, et ses statistiques sont effacées. Il n’y a pas d’archive.',
                                    confirmLabel: 'Supprimer le lien',
                                    onConfirm: () => void remove()
                                })
                            }
                        >
                            Supprimer le lien
                        </Button>
                    </div>
                </div>
            )}

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}
