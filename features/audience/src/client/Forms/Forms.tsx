import { useCallback, useEffect, useState } from 'react';
import {
    Button,
    humanizeError,
    ReadOnlyNotice,
    SegmentedControl,
    SelectInput,
    useResourceVersion,
    useWorkspacePermissions
} from 'deveye-sdk-client';
import type { AudienceForm, AudienceResults, AudienceSite, AudienceSubmission } from '../../contracts/domain';

import { api } from '../api';
import { formatAgo, formatCount } from '../format';
import styles from '../style.module.css';
import FormEditor from '../FormEditor';
import { downloadCsv, toCsv } from './export';
import Results from './Results';
import SubmissionDialog from './SubmissionDialog';
import SubmissionTable from './SubmissionTable';

/** Au-delà, les formulaires ne tiennent plus en boutons collés. */
const SEGMENTED_MAX = 4;

type Tab = 'table' | 'results';

interface FormsProps {
    site: AudienceSite;
    canWrite: boolean;
    /**
     * Le formulaire montré, remonté à la fiche : c'est son en-tête qui porte
     * « Installer », au même endroit que sur les deux autres sections, et le
     * dialogue engendre le `<form>` de celui-ci.
     */
    onCurrentForm: (form: AudienceForm | null) => void;
}

/**
 * Les retours d'un site : ce que ses formulaires ont reçu.
 *
 * Un formulaire se déclare ici, avec ses questions ; c'est ce qui empêche qui
 * lit la clé publique dans la page de décider des colonnes affichées. Ce qu'il
 * faut ensuite coller dans le site vient de « Installer », dans l'en-tête.
 */
export function Forms({ site, canWrite, onCurrentForm }: FormsProps) {
    // Les messages des visiteurs sont la seule donnée nominative du module, et
    // le seul écran qu'un rôle peut se voir refuser sans perdre les chiffres.
    const permissions = useWorkspacePermissions();
    const canRead = permissions.canExtra('audience', 'submissions', String(site.id));
    const canExport = canRead && permissions.canExtra('audience', 'submissionsExport', String(site.id));
    const [forms, setForms] = useState<AudienceForm[] | null>(null);
    const [formId, setFormId] = useState<number | null>(null);
    const [tab, setTab] = useState<Tab>('table');

    const [submissions, setSubmissions] = useState<AudienceSubmission[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [results, setResults] = useState<AudienceResults | null>(null);
    const [opened, setOpened] = useState<AudienceSubmission | null>(null);
    /** `undefined` = fermé ; `null` = déclaration ; un formulaire = modification. */
    const [edit, setEdit] = useState<AudienceForm | null | undefined>(undefined);

    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);

    const formsVersion = useResourceVersion('audience.forms');

    useEffect(() => {
        if (!canRead) return;
        let cancelled = false;
        api.send('audience.formList', { siteId: site.id })
            .then((res) => {
                if (cancelled) return;
                setForms(res.forms);
                // Le formulaire ouvert survit à un rechargement, sauf s'il vient de
                // disparaître : on retombe alors sur le premier plutôt que sur du vide.
                setFormId((prev) =>
                    prev !== null && res.forms.some((f) => f.id === prev) ? prev : (res.forms[0]?.id ?? null)
                );
                setError(null);
            })
            .catch((e: unknown) => {
                if (!cancelled) setError(humanizeError(e, 'Impossible de charger les formulaires.'));
            });
        return () => {
            cancelled = true;
        };
    }, [site.id, formsVersion, canRead]);

    const load = useCallback(async (id: number) => {
        setLoading(true);
        try {
            const [page, next] = await Promise.all([
                api.send('audience.submissionList', { formId: id, order: 'recent' }),
                api.send('audience.results', { formId: id })
            ]);
            setSubmissions(page.submissions);
            setCursor(page.nextCursor);
            setResults(next);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger les retours.'));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (formId === null) {
            setLoading(false);
            return;
        }
        void load(formId);
    }, [formId, load, formsVersion]);

    const loadMore = async () => {
        if (formId === null || cursor === null) return;
        setLoadingMore(true);
        try {
            const page = await api.send('audience.submissionList', { formId, order: 'recent', cursor });
            setSubmissions((prev) => [...prev, ...page.submissions]);
            setCursor(page.nextCursor);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger la suite.'));
        } finally {
            setLoadingMore(false);
        }
    };

    /**
     * Le formulaire montré. `null` tant que la liste n'est pas là : celui d'une
     * visite précédente resterait sinon affiché dans l'en-tête de la fiche.
     */
    const shown = forms?.find((f) => f.id === formId) ?? forms?.[0] ?? null;
    useEffect(() => {
        onCurrentForm(shown);
    }, [shown, onCurrentForm]);
    // En quittant la section, la fiche n'a plus de formulaire ouvert : sans cela
    // son bouton « Installer » engendrerait encore le `<form>` du dernier vu.
    useEffect(() => () => onCurrentForm(null), [onCurrentForm]);

    const editor = (
        <FormEditor
            open={edit !== undefined}
            form={edit ?? null}
            siteId={site.id}
            canWrite={canWrite}
            onClose={() => setEdit(undefined)}
            onSaved={() => {
                // Le formulaire courant a pu être supprimé ou renommé : la liste se
                // relit par l'invalidation et retombe sur le premier restant.
                setFormId(null);
            }}
        />
    );

    if (!canRead) {
        return (
            <ReadOnlyNotice>
                Votre rôle ne donne pas accès aux messages reçus par les formulaires de ce site. Les statistiques,
                elles, restent ouvertes.
            </ReadOnlyNotice>
        );
    }

    if (forms === null) return <p className={error ? styles.error : styles.empty}>{error ?? 'Chargement…'}</p>;

    if (forms.length === 0) {
        return (
            <>
                <section className={styles.panel}>
                    <h3 className={styles.panelTitle}>Aucun formulaire déclaré</h3>
                    <p className={styles.empty}>
                        Un formulaire dit à DevEye ce que votre site enverra : son nom, ses questions et leur type. Sans
                        déclaration, rien n’est accepté : c’est ce qui empêche qui lit la clé publique dans votre page
                        de décider des colonnes affichées ici.
                    </p>
                    {canWrite && (
                        <div className={styles.addRow}>
                            <Button icon='add' onClick={() => setEdit(null)}>
                                Déclarer un formulaire
                            </Button>
                        </div>
                    )}
                    <p className={styles.fieldHint}>
                        Une fois déclaré, « Installer » engendre le <code>&lt;form&gt;</code> exact à coller, et l’appel{' '}
                        <code>window.deveye.submit()</code> pour les pages qui ont du JavaScript.
                    </p>
                </section>
                {editor}
            </>
        );
    }

    const current = shown ?? forms[0];
    const columns = [...new Set(submissions.flatMap((s) => Object.keys(s.fields)))];

    return (
        <div className={styles.view}>
            <div className={styles.viewHead}>
                {forms.length <= SEGMENTED_MAX ? (
                    <SegmentedControl
                        value={String(current.id)}
                        options={forms.map((form) => ({
                            value: String(form.id),
                            label: `${form.name} (${formatCount(form.submissions)})`,
                            title: form.open ? undefined : 'Fermé : plus rien n’entre'
                        }))}
                        aria-label='Formulaire'
                        onChange={(value) => setFormId(Number(value))}
                    />
                ) : (
                    <SelectInput
                        value={String(current.id)}
                        aria-label='Formulaire'
                        onChange={(e) => setFormId(Number(e.target.value))}
                    >
                        {forms.map((form) => (
                            <option key={form.id} value={form.id}>
                                {form.name} ({formatCount(form.submissions)})
                            </option>
                        ))}
                    </SelectInput>
                )}

                <SegmentedControl
                    value={tab}
                    options={[
                        { value: 'table', label: 'Tableau' },
                        { value: 'results', label: 'Résultats' }
                    ]}
                    aria-label='Vue'
                    onChange={(value) => setTab(value as Tab)}
                />

                <p className={styles.formMeta}>
                    {current.open ? 'ouvert' : 'fermé'} · dernier {formatAgo(current.lastAt)}
                </p>

                <div className={styles.detailActions}>
                    {canWrite && (
                        <Button variant='secondary' icon='edit' onClick={() => setEdit(current)}>
                            Modifier
                        </Button>
                    )}
                    {canExport && (
                        <Button
                            variant='secondary'
                            icon='download'
                            disabled={submissions.length === 0}
                            onClick={() => downloadCsv(current.name, toCsv(columns, submissions))}
                        >
                            Exporter
                        </Button>
                    )}
                </div>
            </div>

            {error && <p className={styles.error}>{error}</p>}
            {!current.open && (
                <p className={styles.notice}>
                    {current.closedReason === 'full'
                        ? 'Fermé tout seul : ce formulaire a atteint les 50 000 retours qu’il peut garder. Videz-le avant de le rouvrir.'
                        : 'Ce formulaire est fermé : plus rien n’entre. Les retours ci-dessous ne bougent plus.'}
                </p>
            )}

            {loading && submissions.length === 0 ? (
                <p className={styles.loadingBlock}>
                    <span className={`icon icon-spinner ${styles.spin}`} aria-hidden='true' /> Chargement des retours…
                </p>
            ) : tab === 'results' ? (
                // Le bandeau d'erreur est plus haut, hors de ce cadre : sans ce
                // repli, un échec de lecture ne rendait rien du tout.
                results ? (
                    <Results results={results} />
                ) : (
                    <p className={styles.empty}>La répartition n’a pas pu être lue.</p>
                )
            ) : (
                <SubmissionTable
                    submissions={submissions}
                    nextCursor={cursor}
                    loadingMore={loadingMore}
                    onLoadMore={loadMore}
                    onOpen={setOpened}
                />
            )}

            {/* Toujours en bas, même quand un formulaire existe déjà : on en
                déclare autant qu'on veut, et le geste reste au même endroit. */}
            {canWrite && (
                <div className={styles.addRow}>
                    <Button icon='add' onClick={() => setEdit(null)}>
                        Déclarer un formulaire
                    </Button>
                </div>
            )}

            {editor}

            <SubmissionDialog
                submission={opened}
                canWrite={canWrite}
                onClose={() => setOpened(null)}
                onRemoved={(id) => setSubmissions((prev) => prev.filter((s) => s.id !== id))}
            />
        </div>
    );
}

export default Forms;
