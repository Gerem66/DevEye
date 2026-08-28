import { useEffect, useState } from 'react';
import { Button, Dialog, humanizeError, invalidate, SelectInput, TextInput } from 'deveye-sdk-client';
import {
    AUDIENCE_FUNNEL_MAX_STEPS,
    AUDIENCE_FUNNEL_NAME_MAX_LENGTH,
    type AudienceFunnel,
    type AudienceFunnelStepDraft,
    type AudienceFunnelStepKind
} from '../contracts/domain';

import { api } from './api';
import styles from './style.module.css';

interface FunnelDialogProps {
    open: boolean;
    siteId: number;
    /** `null` = création. */
    funnel: AudienceFunnel | null;
    onClose: () => void;
    onSaved: () => void;
}

const EMPTY: AudienceFunnelStepDraft[] = [
    { kind: 'path', value: '/' },
    { kind: 'event', value: '' }
];

/**
 * Définir un entonnoir à partir de ce que le site a **déjà** émis.
 *
 * Les deux listes déroulantes de suggestions sont le cœur de ce dialogue, pas
 * un confort : un entonnoir se compose de signaux dont le nom exact vit dans le
 * code du site suivi, et les retaper de mémoire est le meilleur moyen de définir
 * une marche qui ne comptera jamais rien — sans que rien ne le signale, puisque
 * zéro est une réponse valable.
 *
 * La saisie libre reste possible malgré tout : on peut vouloir déclarer une
 * marche **avant** que le site ne l'émette, pour que la mesure soit prête le
 * jour de la mise en ligne.
 */
export function FunnelDialog({ open, siteId, funnel, onClose, onSaved }: FunnelDialogProps) {
    const [name, setName] = useState('');
    const [steps, setSteps] = useState<AudienceFunnelStepDraft[]>(EMPTY);
    const [paths, setPaths] = useState<string[]>([]);
    const [events, setEvents] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmRemove, setConfirmRemove] = useState(false);

    useEffect(() => {
        if (!open) return;
        setName(funnel?.name ?? '');
        setSteps(funnel ? funnel.steps.map((s) => ({ kind: s.kind, value: s.value })) : EMPTY);
        setError(null);
        setConfirmRemove(false);

        // Ce que le site a réellement émis, sur une fenêtre large : une marche
        // se définit sur un an d'observations, pas sur les sept derniers jours.
        void (async () => {
            try {
                const [p, e] = await Promise.all([
                    api.send('audience.breakdown', { siteId, range: '365d', dimension: 'path', limit: 50 }),
                    api.send('audience.breakdown', { siteId, range: '365d', dimension: 'event', limit: 50 })
                ]);
                setPaths(p.items.map((i) => i.label).filter(Boolean));
                setEvents(e.items.map((i) => i.label).filter(Boolean));
            } catch {
                // Les suggestions sont un confort : sans elles, la saisie libre
                // suffit. Une erreur ici n'a donc pas à bloquer le dialogue.
            }
        })();
    }, [open, funnel, siteId]);

    const setStep = (index: number, patch: Partial<AudienceFunnelStepDraft>) =>
        setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));

    const move = (index: number, delta: number) =>
        setSteps((prev) => {
            const next = [...prev];
            const target = index + delta;
            if (target < 0 || target >= next.length) return prev;
            [next[index], next[target]] = [next[target], next[index]];
            return next;
        });

    const submit = async () => {
        const clean = steps.map((s) => ({ kind: s.kind, value: s.value.trim() })).filter((s) => s.value.length > 0);
        if (name.trim().length === 0) {
            setError('Donnez un nom à cet entonnoir.');
            return;
        }
        if (clean.length < 2) {
            setError('Un entonnoir demande au moins deux marches.');
            return;
        }

        setBusy(true);
        setError(null);
        try {
            if (funnel)
                await api.send('audience.funnelUpdate', { funnelId: funnel.id, name: name.trim(), steps: clean });
            else await api.send('audience.funnelAdd', { siteId, name: name.trim(), steps: clean });
            invalidate('audience.stats');
            onSaved();
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!funnel) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('audience.funnelRemove', { funnelId: funnel.id });
            invalidate('audience.stats');
            onSaved();
        } catch (e) {
            setError(humanizeError(e, 'Suppression impossible.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={funnel ? 'Modifier l’entonnoir' : 'Nouvel entonnoir'}
            width={620}
            onSubmit={confirmRemove ? () => void remove() : () => void submit()}
            footer={
                confirmRemove ? (
                    <>
                        <Button variant='secondary' onClick={() => setConfirmRemove(false)} disabled={busy}>
                            Annuler
                        </Button>
                        <Button variant='danger' onClick={() => void remove()} disabled={busy}>
                            {busy ? 'Suppression…' : 'Supprimer'}
                        </Button>
                    </>
                ) : (
                    <>
                        {funnel && (
                            <Button variant='ghost' onClick={() => setConfirmRemove(true)} disabled={busy}>
                                Supprimer
                            </Button>
                        )}
                        <Button variant='secondary' onClick={onClose} disabled={busy}>
                            Annuler
                        </Button>
                        <Button onClick={() => void submit()} disabled={busy}>
                            {busy ? 'Enregistrement…' : funnel ? 'Enregistrer' : 'Créer'}
                        </Button>
                    </>
                )
            }
        >
            {confirmRemove ? (
                <p className={styles.confirm}>
                    Supprimer « {funnel?.name} » n’efface <strong>aucune mesure</strong> : un entonnoir n’est qu’une
                    lecture des événements déjà collectés. Le recréer à l’identique rendrait exactement les mêmes
                    chiffres.
                </p>
            ) : (
                <div className={styles.form}>
                    <label className={styles.field}>
                        <span className={styles.label}>Nom</span>
                        <TextInput
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            maxLength={AUDIENCE_FUNNEL_NAME_MAX_LENGTH}
                            placeholder='Demande de devis, Inscription…'
                        />
                    </label>

                    {/* Les listes de suggestions sont partagées par toutes les
                        marches : elles ne dépendent que du site. */}
                    <datalist id='audiencePaths'>
                        {paths.map((p) => (
                            <option key={p} value={p} />
                        ))}
                    </datalist>
                    <datalist id='audienceEvents'>
                        {events.map((e) => (
                            <option key={e} value={e} />
                        ))}
                    </datalist>

                    <div className={styles.field}>
                        <span className={styles.label}>Marches, dans l’ordre</span>
                        <ol className={styles.stepList}>
                            {steps.map((step, index) => (
                                <li key={index} className={styles.stepRow}>
                                    <span className={styles.stepIndex}>{index + 1}</span>
                                    <SelectInput
                                        className={styles.stepKind}
                                        value={step.kind}
                                        onChange={(e) =>
                                            setStep(index, { kind: e.target.value as AudienceFunnelStepKind })
                                        }
                                    >
                                        <option value='path'>Page vue</option>
                                        <option value='event'>Événement</option>
                                    </SelectInput>
                                    {/* `TextInput` rend un conteneur sans largeur
                                        propre : dans une ligne flex il se réduit
                                        à son contenu et tronque la saisie alors
                                        que la place est libre. C'est cette
                                        enveloppe qui la lui donne. */}
                                    <div className={styles.stepValue}>
                                        <TextInput
                                            value={step.value}
                                            list={step.kind === 'path' ? 'audiencePaths' : 'audienceEvents'}
                                            placeholder={step.kind === 'path' ? '/devis' : 'devis-envoye'}
                                            onChange={(e) => setStep(index, { value: e.target.value })}
                                        />
                                    </div>
                                    <div className={styles.stepActions}>
                                        <button
                                            type='button'
                                            className={styles.stepBtn}
                                            aria-label='Monter'
                                            disabled={index === 0}
                                            onClick={() => move(index, -1)}
                                        >
                                            <span className={`icon icon-chevron ${styles.chevronUp}`} />
                                        </button>
                                        <button
                                            type='button'
                                            className={styles.stepBtn}
                                            aria-label='Descendre'
                                            disabled={index === steps.length - 1}
                                            onClick={() => move(index, 1)}
                                        >
                                            <span className={`icon icon-chevron ${styles.chevronDown}`} />
                                        </button>
                                        <button
                                            type='button'
                                            className={styles.stepBtn}
                                            aria-label='Retirer'
                                            disabled={steps.length <= 2}
                                            onClick={() => setSteps((prev) => prev.filter((_, i) => i !== index))}
                                        >
                                            <span className={`icon icon-trash ${styles.stepIcon}`} />
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ol>
                        {steps.length < AUDIENCE_FUNNEL_MAX_STEPS && (
                            <Button
                                variant='ghost'
                                icon='add'
                                onClick={() => setSteps((prev) => [...prev, { kind: 'event', value: '' }])}
                            >
                                Ajouter une marche
                            </Button>
                        )}
                        <span className={styles.hint}>
                            Une visite compte pour une marche si elle a franchi toutes les précédentes,{' '}
                            <strong>dans cet ordre</strong>. Une marche qu’aucune visite n’a encore déclenchée compte
                            zéro.
                        </span>
                    </div>

                    {error && <p className={styles.error}>{error}</p>}
                </div>
            )}
        </Dialog>
    );
}

export default FunnelDialog;
