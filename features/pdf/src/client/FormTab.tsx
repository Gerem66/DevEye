import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Switch } from 'deveye-sdk-client';

import { Picto } from './icons';
import type { FieldValue } from './build';
import { pageAnnotations } from './documents';
import { fieldLabel, fieldsOf, fieldViewRect, type FormField } from './fields';
import type { Frame } from './geometry';
import { displayedSize, sourceOf, totalRotation, type Plan, type PlanPage } from './model';
import styles from './pdf.module.css';
import { thumbnail } from './thumbnails';
import type { Workshop } from './usePdfWorkshop';

const STAGE_MAX_WIDTH = 920;

type SourcePage = Extract<PlanPage, { kind: 'source' }>;

/** La valeur en vigueur : celle saisie, sinon celle que le fichier porte. */
const valueOf = (field: FormField, saved: FieldValue | undefined): FieldValue => saved ?? field.value;

/** Un champ de texte qui ne s'enregistre qu'au départ du champ ou à Entrée : un pas d'historique par saisie, pas par touche. */
function TextField(props: {
    field: FormField;
    value: string;
    onCommit: (value: string) => void;
    className: string;
    style?: CSSProperties;
    ariaLabel: string;
}) {
    const { field, value, onCommit, className, style, ariaLabel } = props;
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);
    const commit = (): void => {
        if (draft !== value) onCommit(draft);
    };
    if (field.multiLine) {
        return (
            <textarea
                className={className}
                style={style}
                value={draft}
                readOnly={field.readOnly}
                aria-label={ariaLabel}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
            />
        );
    }
    return (
        <input
            type='text'
            className={className}
            style={style}
            value={draft}
            readOnly={field.readOnly}
            aria-label={ariaLabel}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
            }}
        />
    );
}

/** Le contrôle d'un champ, sur la page ou dans la liste : le même, à la place près. */
function FieldControl(props: {
    field: FormField;
    value: FieldValue;
    onChange: (value: FieldValue) => void;
    onPage: boolean;
    style?: CSSProperties;
}) {
    const { field, value, onChange, onPage, style } = props;
    const label = fieldLabel(field.name);
    switch (field.kind) {
        case 'text':
            return (
                <TextField
                    field={field}
                    value={typeof value === 'string' ? value : ''}
                    onCommit={onChange}
                    className={onPage ? styles.fieldInput : styles.fieldListInput}
                    style={style}
                    ariaLabel={label}
                />
            );
        case 'checkbox':
            return (
                <input
                    type='checkbox'
                    className={onPage ? styles.fieldCheck : styles.fieldListCheck}
                    style={style}
                    checked={value === true}
                    disabled={field.readOnly}
                    aria-label={label}
                    onChange={(e) => onChange(e.target.checked)}
                />
            );
        case 'radio':
            return (
                <input
                    type='radio'
                    className={onPage ? styles.fieldCheck : styles.fieldListCheck}
                    style={style}
                    checked={field.onValue !== null && value === field.onValue}
                    disabled={field.readOnly || field.onValue === null}
                    aria-label={`${label} : ${field.onValue ?? ''}`}
                    onChange={() => field.onValue !== null && onChange(field.onValue)}
                />
            );
        case 'choice':
            return (
                <select
                    className={onPage ? styles.fieldInput : styles.fieldListInput}
                    style={style}
                    value={typeof value === 'string' ? value : ''}
                    disabled={field.readOnly}
                    aria-label={label}
                    onChange={(e) => onChange(e.target.value)}
                >
                    <option value=''>(vide)</option>
                    {field.options.map((o) => (
                        <option key={o.value} value={o.value}>
                            {o.label}
                        </option>
                    ))}
                </select>
            );
    }
}

/** La page avec ses champs posés dessus, à leur place. */
function FormStage(props: {
    page: SourcePage;
    plan: Plan;
    fields: readonly FormField[];
    values: Readonly<Record<string, FieldValue>>;
    onChange: (name: string, value: FieldValue) => void;
}) {
    const { page, plan, fields, values, onChange } = props;
    const wrap = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);
    const [url, setUrl] = useState<string | null>(null);
    const size = displayedSize(page, plan);
    const scale = width > 0 ? width / size.width : 1;
    const geometry = sourceOf(plan, page.sourceId)?.pages[page.index];
    const frame: Frame = {
        view: geometry?.view ?? [0, 0, size.width, size.height],
        rotation: totalRotation(page, plan)
    };

    useEffect(() => {
        const el = wrap.current;
        if (!el) return;
        const measure = () => setWidth(Math.max(120, Math.min(STAGE_MAX_WIDTH, Math.floor(el.clientWidth))));
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const rotation = page.rotation;
    useEffect(() => {
        if (width === 0) return;
        let cancelled = false;
        thumbnail(page, plan, width)
            .then((u) => {
                if (!cancelled) setUrl(u);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [page, rotation, width, plan]);

    return (
        <div ref={wrap} className={styles.stageWrap}>
            <div className={styles.stage} style={{ width, height: Math.round(size.height * scale) }}>
                {url ? <img className={styles.stageImage} src={url} alt='' draggable={false} /> : null}
                <div className={styles.overlay}>
                    {fields.map((field, i) => {
                        const rect = fieldViewRect(field, frame);
                        const box: CSSProperties = {
                            left: rect.x * scale,
                            top: rect.y * scale,
                            width: rect.width * scale,
                            height: rect.height * scale
                        };
                        const fontSize = `${Math.max(9, Math.min(rect.height * 0.6, 14) * scale)}px`;
                        return (
                            <div key={`${field.name}-${i}`} className={styles.fieldBox} style={box}>
                                <FieldControl
                                    field={field}
                                    value={valueOf(field, values[field.name])}
                                    onChange={(v) => onChange(field.name, v)}
                                    onPage
                                    style={field.kind === 'text' || field.kind === 'choice' ? { fontSize } : undefined}
                                />
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

interface FormTabProps {
    workshop: Workshop;
}

/** Remplir un formulaire : la page avec ses champs, la liste à côté, et le choix de les figer. */
export function FormTab({ workshop }: FormTabProps) {
    const { plan, fields: values, flatten, act } = workshop;
    const formSources = plan.sources.filter((s) => s.hasForm);
    const formPages = plan.pages.filter(
        (p): p is SourcePage => p.kind === 'source' && formSources.some((s) => s.id === p.sourceId)
    );
    const [pageId, setPageId] = useState<string | null>(null);
    const page = formPages.find((p) => p.id === pageId) ?? formPages[0] ?? null;
    const index = page ? formPages.findIndex((p) => p.id === page.id) : -1;
    const [widgets, setWidgets] = useState<ReadonlyMap<string, readonly FormField[]>>(new Map());

    // Les champs d'une page se lisent une fois, à son affichage.
    const key = page ? `${page.sourceId}/${page.index}` : null;
    useEffect(() => {
        if (!page || key === null || widgets.has(key)) return;
        let cancelled = false;
        pageAnnotations(page.sourceId, page.index)
            .then((annotations) => {
                if (!cancelled) setWidgets((w) => new Map(w).set(key, fieldsOf(annotations)));
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [page, key, widgets]);

    const several = formSources.length > 1;
    const xfaOnly = formSources.length > 0 && formSources.every((s) => s.pureXfa);
    const frozen = flatten || several;

    if (!page) return <p className={styles.note}>Aucun formulaire dans ces fichiers.</p>;
    const pageFields = widgets.get(key ?? '') ?? [];
    const pageValues = values[page.sourceId] ?? {};
    const onChange = (name: string, value: FieldValue) => act('setField', { sourceId: page.sourceId, name, value });

    return (
        <div className={styles.editTab}>
            <div className={styles.toolbar}>
                <div className={styles.pageNav}>
                    <button
                        type='button'
                        className={styles.iconButton}
                        aria-label='Page précédente'
                        title='Page précédente'
                        disabled={index <= 0}
                        onClick={() => setPageId(formPages[index - 1]?.id ?? null)}
                    >
                        <Picto id='prev' size={16} />
                    </button>
                    <span className={styles.pageNavLabel} aria-live='polite'>
                        {index + 1} / {formPages.length}
                    </span>
                    <button
                        type='button'
                        className={styles.iconButton}
                        aria-label='Page suivante'
                        title='Page suivante'
                        disabled={index >= formPages.length - 1}
                        onClick={() => setPageId(formPages[index + 1]?.id ?? null)}
                    >
                        <Picto id='next' size={16} />
                    </button>
                </div>
                <span className={styles.toolbarText}>
                    {pageFields.length === 0
                        ? 'Aucun champ sur cette page.'
                        : `${pageFields.length} champ${pageFields.length > 1 ? 's' : ''} sur cette page.`}
                </span>
                <div className={styles.toolbarEnd}>
                    <Switch
                        label='Figer les champs'
                        hint={
                            several
                                ? 'Les champs viennent de plusieurs fichiers : deux formulaires ne se fondent pas en un, ils seront figés.'
                                : 'Le document produit ne se remplit plus : ce qui est saisi devient du contenu.'
                        }
                        checked={frozen}
                        disabled={several}
                        onChange={(next) => act('setFlatten', { flatten: next })}
                    />
                </div>
            </div>
            {xfaOnly && (
                <p className={styles.warning}>
                    Ce formulaire est au format XFA : ses champs ne se remplissent pas ici. Vous pouvez tout de même
                    écrire dessus dans l’onglet Signer et annoter.
                </p>
            )}
            <div className={styles.editBody}>
                <FormStage page={page} plan={plan} fields={pageFields} values={pageValues} onChange={onChange} />
                <aside className={styles.inspector}>
                    <h3 className={styles.inspectorTitle}>Champs de la page</h3>
                    {pageFields.length === 0 && <p className={styles.inspectorHint}>Rien à remplir sur cette page.</p>}
                    {pageFields.map((field, i) => (
                        <label key={`${field.name}-${i}`} className={styles.fieldRow}>
                            <span className={styles.inspectorLabel}>
                                {fieldLabel(field.name)}
                                {field.kind === 'radio' && field.onValue !== null ? ` : ${field.onValue}` : ''}
                            </span>
                            <FieldControl
                                field={field}
                                value={valueOf(field, pageValues[field.name])}
                                onChange={(v) => onChange(field.name, v)}
                                onPage={false}
                            />
                        </label>
                    ))}
                </aside>
            </div>
        </div>
    );
}
