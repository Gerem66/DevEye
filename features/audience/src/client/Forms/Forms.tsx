import { useCallback, useEffect, useState } from 'react';
import { Button, humanizeError, SegmentedControl, SelectInput, useResourceVersion } from 'deveye-sdk-client';
import type { AudienceForm, AudienceResults, AudienceSite, AudienceSubmission } from '../../contracts/domain';

import { api } from '../api';
import { formatAgo, formatCount, formSnippetFor } from '../format';
import styles from '../style.module.css';
import { downloadCsv, toCsv } from './export';
import FormDialog from './FormDialog';
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
    const [settingsOpen, setSettingsOpen] = useState(false);

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

    if (forms === null) return <p className={error ? styles.error : styles.empty}>{error ?? 'Chargement…'}</p>;

    if (forms.length === 0) {
        return (
            <section className={styles.panel}>
                <h3 className={styles.panelTitle}>Aucun retour pour l’instant</h3>
                <p className={styles.empty}>
                    Un formulaire apparaît ici dès son premier envoi : il n’y a rien à déclarer avant. Collez ceci dans
                    une page servie par une origine autorisée, et le formulaire « contact » se créera tout seul.
                </p>
                <pre className={styles.raw}>{formSnippetFor(site.publicKey, ingestOrigin, 'contact')}</pre>
                <p className={styles.fieldHint}>
                    Avec du JavaScript, <code>window.deveye.submit(&apos;contact&apos;, champs)</code> fait la même
                    chose sans quitter la page. Les deux voies sont détaillées dans « Installer ».
                </p>
            </section>
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
                    <Button
                        variant='secondary'
                        icon='download'
                        disabled={submissions.length === 0}
                        onClick={() => downloadCsv(current.name, toCsv(columns, submissions))}
                    >
                        Exporter
                    </Button>
                    <Button variant='secondary' icon='settings' onClick={() => setSettingsOpen(true)}>
                        Réglages
                    </Button>
                </div>
            </div>

            {error && <p className={styles.error}>{error}</p>}
            {!current.open && (
                <p className={styles.notice}>
                    Ce formulaire est fermé : plus rien n’entre. Les retours ci-dessous ne bougent plus.
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

            <SubmissionDialog
                submission={opened}
                canWrite={canWrite}
                onClose={() => setOpened(null)}
                onRemoved={(id) => setSubmissions((prev) => prev.filter((s) => s.id !== id))}
            />

            <FormDialog
                form={settingsOpen ? current : null}
                canWrite={canWrite}
                onClose={() => setSettingsOpen(false)}
                onChanged={(removed) => {
                    // Supprimé, l'identifiant courant ne désigne plus rien : la liste
                    // se relit par l'invalidation et retombe sur le premier restant.
                    if (removed) setFormId(null);
                }}
            />
        </div>
    );
}

export default Forms;
