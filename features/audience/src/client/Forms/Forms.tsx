import { useCallback, useEffect, useState } from 'react';
import { Button, humanizeError, SegmentedControl, SelectInput, useResourceVersion } from 'deveye-sdk-client';
import type { AudienceForm, AudienceResults, AudienceSite, AudienceSubmission } from '../../contracts/domain';

import { api } from '../api';
import { formatAgo, formatCount } from '../format';
import styles from '../style.module.css';
import FormEditor from '../FormEditor';
import InstallDialog from '../InstallDialog';
import { downloadCsv, toCsv } from './export';
import Results from './Results';
import SubmissionDialog from './SubmissionDialog';
import SubmissionTable from './SubmissionTable';

/** Au-delà, les formulaires ne tiennent plus en boutons collés. */
const SEGMENTED_MAX = 4;

type Tab = 'table' | 'results';

interface FormsProps {
    site: AudienceSite;
    /** L'adresse de la porte publique, telle que le serveur la connaît. */
    ingestOrigin: string;
    canWrite: boolean;
}

/**
 * Les retours d'un site : ce que ses formulaires ont reçu.
 *
 * Rien ici ne crée de formulaire, et c'est le point : un canal naît de sa
 * première réception. L'écran vide n'est donc pas un formulaire à remplir mais
 * la balise à coller, ce qui est la seule chose à faire à ce moment-là.
 */
export function Forms({ site, ingestOrigin, canWrite }: FormsProps) {
    const [forms, setForms] = useState<AudienceForm[] | null>(null);
    const [formId, setFormId] = useState<number | null>(null);
    const [tab, setTab] = useState<Tab>('table');

    const [submissions, setSubmissions] = useState<AudienceSubmission[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [results, setResults] = useState<AudienceResults | null>(null);
    const [opened, setOpened] = useState<AudienceSubmission | null>(null);
    const [installOpen, setInstallOpen] = useState(false);
    /** `undefined` = fermé ; `null` = déclaration ; un formulaire = modification. */
    const [edit, setEdit] = useState<AudienceForm | null | undefined>(undefined);

    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);

    const formsVersion = useResourceVersion('audience.forms');

    useEffect(() => {
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
    }, [site.id, formsVersion]);

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

    /* Monté par les deux branches : l'écran vide fait un retour anticipé, et
       « Installer » y est encore plus utile qu'ailleurs — c'est le moment où
       l'on cherche quoi coller. `current` n'existe pas encore là, d'où le
       `?? null` : le dialogue retombe sur un exemple générique. */
    const installer = (
        <InstallDialog
            open={installOpen}
            scope='forms'
            form={forms?.find((f) => f.id === formId) ?? forms?.[0] ?? null}
            site={site}
            ingestOrigin={ingestOrigin}
            canWrite={canWrite}
            onClose={() => setInstallOpen(false)}
        />
    );

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

    if (forms === null) return <p className={error ? styles.error : styles.empty}>{error ?? 'Chargement…'}</p>;

    if (forms.length === 0) {
        return (
            <>
                <section className={styles.panel}>
                    <h3 className={styles.panelTitle}>Aucun formulaire déclaré</h3>
                    <p className={styles.empty}>
                        Un formulaire dit à DevEye ce que votre site enverra : son nom, ses questions et leur type. Sans
                        déclaration, rien n’est accepté — c’est ce qui empêche qui lit la clé publique dans votre page
                        de décider des colonnes affichées ici.
                    </p>
                    <div className={styles.addRow}>
                        {canWrite && (
                            <Button icon='add' onClick={() => setEdit(null)}>
                                Déclarer un formulaire
                            </Button>
                        )}
                        {/* Ici plus qu'ailleurs : c'est le moment où l'on cherche
                            quoi coller, et l'écran d'installation montre les deux
                            voies d'envoi avant même qu'un formulaire existe. */}
                        <Button variant='secondary' icon='terminal' onClick={() => setInstallOpen(true)}>
                            Installer
                        </Button>
                    </div>
                    <p className={styles.fieldHint}>
                        Une fois déclaré, « Installer » engendre le <code>&lt;form&gt;</code> exact à coller, et l’appel{' '}
                        <code>window.deveye.submit()</code> pour les pages qui ont du JavaScript.
                    </p>
                </section>
                {editor}
                {installer}
            </>
        );
    }

    const current = forms.find((f) => f.id === formId) ?? forms[0];
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
                    <Button variant='secondary' icon='terminal' onClick={() => setInstallOpen(true)}>
                        Installer
                    </Button>
                    {canWrite && (
                        <Button variant='secondary' icon='edit' onClick={() => setEdit(current)}>
                            Modifier
                        </Button>
                    )}
                    <Button
                        variant='secondary'
                        icon='download'
                        disabled={submissions.length === 0}
                        onClick={() => downloadCsv(current.name, toCsv(columns, submissions))}
                    >
                        Exporter
                    </Button>
                </div>
            </div>

            {error && <p className={styles.error}>{error}</p>}
            {!current.open && (
                <p className={styles.notice}>
                    {current.closedReason === 'quota'
                        ? 'Fermé automatiquement : une rafale a dépassé le quota horaire. Les retours ci-dessous ne bougent plus, et vous pouvez le rouvrir depuis les réglages du site.'
                        : current.closedReason === 'full'
                          ? 'Fermé automatiquement : le plafond de stockage est atteint. Videz-le avant de le rouvrir.'
                          : 'Ce formulaire est fermé : plus rien n’entre. Les retours ci-dessous ne bougent plus.'}
                </p>
            )}

            {loading && submissions.length === 0 ? (
                <p className={styles.loadingBlock}>
                    <span className={`icon icon-spinner ${styles.spin}`} aria-hidden='true' /> Chargement des retours…
                </p>
            ) : tab === 'results' ? (
                results && <Results results={results} />
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

            {installer}

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
