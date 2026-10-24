import {
    Button,
    ConfirmDialog,
    Dialog,
    DialogCancelButton,
    ErrorNote,
    SearchSelect,
    SegmentedControl,
    StatusBadge,
    TextArea,
    TextInput,
    errorNote,
    invalidate,
    useResource,
    useSubView,
    type ConfirmRequest,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import { useState } from 'react';
import { MODERATION_REASONS, type ModerationReason } from '@deveye/types/sdk';

import {
    MODERATION_REASON_LABELS,
    RULE_EXPOSURE_LABELS,
    RULE_SOURCE_LABELS,
    type FeedStatus,
    type Rule,
    type RuleExposure,
    type RuleKind
} from '../contracts/domain';
import { api } from './api';
import { momentLabel, plural, shortHash } from './format';
import styles from './style.module.css';

const READ_FAILED = 'Les règles n’ont pas pu être lues.';

const KIND_OPTIONS = [
    { value: 'fingerprint' as const, label: 'Empreintes', title: 'Le SHA-256 d’un contenu, quel que soit son nom' },
    { value: 'name' as const, label: 'Noms de fichiers', title: 'Un motif sur le nom, avec * et ?' }
];

const EXPOSURE_OPTIONS = [
    { value: 'public' as const, label: 'Pages publiques', title: RULE_EXPOSURE_LABELS.public },
    { value: 'everywhere' as const, label: 'Partout', title: RULE_EXPOSURE_LABELS.everywhere }
];

const REASON_OPTIONS = MODERATION_REASONS.map((reason) => ({ value: reason, label: MODERATION_REASON_LABELS[reason] }));

type Draft = { kind: RuleKind; text: string; reason: ModerationReason; label: string; exposure: RuleExposure };
const EMPTY_DRAFT: Draft = { kind: 'fingerprint', text: '', reason: 'malware', label: '', exposure: 'everywhere' };

/** Combien de motifs le texte porte, lignes vides et commentaires exclus : ce que le bouton annonce. */
const countLines = (text: string): number =>
    text.split(/\r?\n/).filter((line) => line.trim().length > 0 && !line.trim().startsWith('#')).length;

/**
 * Les règles de la modération automatique : ce que les fonctionnalités qui
 * gardent des fichiers arrêtent à l'arrivée. Une empreinte arrête un contenu
 * précis, un motif de nom arrête d'après le nom seul ; chacune dit où elle
 * s'applique et ce que lit la personne arrêtée.
 */
export default function Rules() {
    const [adding, setAdding] = useState(false);
    const [lastAdd, setLastAdd] = useState<{ added: number; ignored: number } | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    useSubView('regles');

    const rules = useResource('x-moderation.rules', () => api.send('x-moderation.rules', {}), READ_FAILED);

    const askRemove = (rule: Rule): void =>
        setConfirm({
            title: rule.kind === 'fingerprint' ? 'Retirer cette empreinte ?' : `Retirer le motif « ${rule.pattern} » ?`,
            description: 'Ce qu’elle arrêtait passera de nouveau. Ce qui a déjà été retenu ou refusé ne change pas.',
            confirmLabel: 'Retirer',
            onConfirm: () => {
                setLastAdd(null);
                void api
                    .send('x-moderation.ruleRemove', { ruleId: rule.id })
                    .then(() => invalidate('x-moderation.rules'))
                    .catch((failure: unknown) => setError(errorNote(failure, 'La règle n’a pas pu être retirée.')));
            }
        });

    const list = rules.data?.rules ?? null;

    return (
        <div className={styles.tab}>
            <ErrorNote note={error} onDismiss={() => setError(null)} />
            <p className={styles.lead}>
                Chaque fichier qui arrive dans Hébergement ou CloudSync est comparé à ces règles. Dans Hébergement, un
                fichier arrêté est retenu et ouvre un signalement ; dans CloudSync, il est refusé et son propriétaire le
                lit au Journal du partage. Rien de déjà en place n’est réexaminé.
            </p>

            <FeedCard feed={rules.data?.feed ?? null} />

            <section>
                <div className={styles.sectionHead}>
                    <h3 className={styles.sectionTitle}>
                        {list === null ? 'Règles' : plural(list.length, 'règle', 'règles')}
                    </h3>
                    <div className={styles.headActions}>
                        <Button variant='primary' onClick={() => setAdding(true)}>
                            Ajouter des règles
                        </Button>
                    </div>
                </div>
                {lastAdd !== null && (
                    <p className={styles.cardText}>
                        {plural(lastAdd.added, 'règle ajoutée', 'règles ajoutées')}
                        {lastAdd.ignored > 0
                            ? `, ${plural(lastAdd.ignored, 'ligne ignorée', 'lignes ignorées')} (déjà posée, ou pas un motif)`
                            : ''}
                        .
                    </p>
                )}
                {rules.error !== null ? (
                    <ErrorNote note={rules.error} />
                ) : list === null ? (
                    <p className={styles.empty}>Chargement…</p>
                ) : list.length === 0 ? (
                    <p className={styles.empty}>Aucune règle : rien n’est arrêté automatiquement.</p>
                ) : (
                    <ul className={styles.list}>
                        {list.map((rule) => (
                            <RuleCard key={rule.id} rule={rule} onRemove={() => askRemove(rule)} />
                        ))}
                    </ul>
                )}
            </section>

            <AddDialog
                open={adding}
                onClose={() => setAdding(false)}
                onAdded={(result) => {
                    setLastAdd(result);
                    setAdding(false);
                }}
            />
            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
        </div>
    );
}

function FeedCard({ feed }: { feed: FeedStatus | null }) {
    if (feed === null || !feed.configured) return null;
    return (
        <div className={styles.feed}>
            <span className={styles.feedTitle}>
                Liste externe d’empreintes
                <StatusBadge
                    tone={feed.lastError !== null ? 'danger' : feed.lastImport === null ? 'neutral' : 'success'}
                >
                    {feed.lastError !== null ? 'en échec' : feed.lastImport === null ? 'jamais relue' : 'à jour'}
                </StatusBadge>
            </span>
            <span>
                {plural(feed.count, 'empreinte importée', 'empreintes importées')}, relue toutes les heures
                {feed.lastImport === null ? '' : `, la dernière fois ${momentLabel(feed.lastImport)}`}. Elles
                s’appliquent partout, et ne figurent pas dans la liste ci-dessous.
            </span>
            {feed.lastError !== null && (
                <span className={styles.feedError}>Dernière relecture en échec : {feed.lastError}</span>
            )}
        </div>
    );
}

function RuleCard({ rule, onRemove }: { rule: Rule; onRemove: () => void }) {
    return (
        <li className={styles.card}>
            <div className={styles.cardHead}>
                <span className={styles.cardTitle}>
                    <StatusBadge tone='neutral' dot={false}>
                        {rule.kind === 'fingerprint' ? 'Empreinte' : 'Nom'}
                    </StatusBadge>
                    <span className={styles.pattern} title={rule.pattern}>
                        {rule.kind === 'fingerprint' ? shortHash(rule.pattern) : rule.pattern}
                    </span>
                    <StatusBadge tone='warning' dot={false}>
                        {MODERATION_REASON_LABELS[rule.reason]}
                    </StatusBadge>
                </span>
                <span className={styles.cardMeta}>
                    {RULE_EXPOSURE_LABELS[rule.exposure]} · {RULE_SOURCE_LABELS[rule.source]} ·{' '}
                    {momentLabel(rule.created)}
                </span>
            </div>
            <p className={styles.cardText}>{rule.label}</p>
            <p className={styles.cardMeta}>
                {rule.hits === 0
                    ? 'Jamais déclenchée'
                    : `${plural(rule.hits, 'détection', 'détections')}${rule.lastHit === null ? '' : `, la dernière ${momentLabel(rule.lastHit)}`}`}
            </p>
            <div className={styles.inlineActions}>
                <Button variant='ghost' onClick={onRemove}>
                    Retirer
                </Button>
            </div>
        </li>
    );
}

function AddDialog({
    open,
    onClose,
    onAdded
}: {
    open: boolean;
    onClose: () => void;
    onAdded: (result: { added: number; ignored: number }) => void;
}) {
    const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const count = countLines(draft.text);

    const close = () => {
        setDraft(EMPTY_DRAFT);
        setError(null);
        onClose();
    };

    const submit = async (): Promise<void> => {
        if (busy || count === 0) return;
        setBusy(true);
        setError(null);
        try {
            const result = await api.send('x-moderation.rulesAdd', { rules: draft });
            invalidate('x-moderation.rules');
            setDraft(EMPTY_DRAFT);
            onAdded(result);
        } catch (failure) {
            setError(errorNote(failure, 'Les règles n’ont pas pu être ajoutées.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={close}
            title='Ajouter des règles'
            description='Un motif par ligne, autant que vous voulez. Elles s’appliquent aux fichiers qui arrivent à partir de maintenant.'
            onSubmit={() => void submit()}
            footer={
                <>
                    <DialogCancelButton variant='ghost'>Annuler</DialogCancelButton>
                    <Button variant='primary' disabled={busy || count === 0} onClick={() => void submit()}>
                        {count > 1 ? `Ajouter ${count} règles` : 'Ajouter'}
                    </Button>
                </>
            }
        >
            <div className={styles.field}>
                <span className={styles.fieldLabel}>Ce que les règles reconnaissent</span>
                <SegmentedControl
                    options={KIND_OPTIONS}
                    value={draft.kind}
                    onChange={(kind) => setDraft({ ...draft, kind, text: '' })}
                    aria-label='Genre de règle'
                />
            </div>
            <div className={styles.field}>
                <label htmlFor='moderation-patterns'>
                    {draft.kind === 'fingerprint' ? 'Empreintes SHA-256, une par ligne' : 'Motifs de nom, un par ligne'}
                </label>
                <TextArea
                    id='moderation-patterns'
                    className={styles.mono}
                    rows={5}
                    autoGrow
                    value={draft.text}
                    placeholder={draft.kind === 'fingerprint' ? '64 caractères hexadécimaux par ligne' : '*.torrent'}
                    spellCheck={false}
                    data-autofocus=''
                    onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                />
                <span className={styles.fieldHint}>
                    {draft.kind === 'fingerprint'
                        ? 'Le SHA-256 du contenu, tel que « sha256sum » l’affiche ; une liste collée passe telle quelle, ce qui n’est pas une empreinte est ignoré. Le nom du fichier n’y change rien.'
                        : 'Sur le nom entier, casse ignorée : « * » remplace une suite quelconque, « ? » un caractère.'}
                </span>
            </div>
            <div className={styles.field}>
                <label htmlFor='moderation-reason'>Motif</label>
                <SearchSelect
                    id='moderation-reason'
                    value={draft.reason}
                    options={REASON_OPTIONS}
                    onChange={(reason) => setDraft({ ...draft, reason })}
                    aria-label='Motif d’interdiction'
                />
            </div>
            <div className={styles.field}>
                <label htmlFor='moderation-label'>Ce que lit la personne arrêtée</label>
                <TextInput
                    id='moderation-label'
                    value={draft.label}
                    maxLength={200}
                    placeholder={MODERATION_REASON_LABELS[draft.reason]}
                    onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                />
                <span className={styles.fieldHint}>
                    Vide, c’est le motif qui est lu. La personne ne voit que cette phrase : dans l’explorateur
                    d’Hébergement sur son fichier retenu, et au Journal de CloudSync sur son fichier refusé.
                </span>
            </div>
            <div className={styles.field}>
                <span className={styles.fieldLabel}>Où elles s’appliquent</span>
                <SegmentedControl
                    options={EXPOSURE_OPTIONS}
                    value={draft.exposure}
                    onChange={(exposure) => setDraft({ ...draft, exposure })}
                    aria-label='Portée des règles'
                />
                <span className={styles.fieldHint}>
                    « Pages publiques » ne regarde que ce qui se donne par une adresse ; « Partout » regarde aussi ce
                    qu’un compte garde pour lui et ses appareils.
                </span>
            </div>
            <ErrorNote note={error} />
        </Dialog>
    );
}
