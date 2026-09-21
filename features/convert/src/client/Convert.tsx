import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Button,
    Dialog,
    FeatureSettingsButton,
    formatBytesFr,
    humanizeError,
    invalidate,
    onServerEvent,
    useResource,
    useWorkspacePermissions
} from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';

import { kindOf, outputName, sourceOf, targetOf } from '../contracts/catalogue';
import {
    CONVERT_PROGRESS_EVENT,
    convertProgressSchema,
    type ConvertJob,
    type ConvertProgress
} from '../contracts/domain';
import { outputDims } from '../contracts/estimate';
import { resolveOptions } from '../contracts/options';
import { manifest } from '../manifest';
import { adaptOptions } from './adaptOptions';
import { api } from './api';
import { Currency } from './Currency';
import { FilePane, type FileResult } from './FilePane';
import { KIND_NOUNS } from './format';
import { JobList } from './JobList';
import { probeFile } from './probe';
import { Stepper, type StepperStep } from './Stepper';
import { ExportStep, isLocked, type Sending, type Tracked } from './steps/ExportStep';
import { FormatStep } from './steps/FormatStep';
import { KindStep } from './steps/KindStep';
import { OptionsStep } from './steps/OptionsStep';
import styles from './style.module.css';
import { Units } from './Units';
import { saveFrom, UploadError, uploadFile, type UploadHandle } from './upload';
import { useEstimate } from './useEstimate';
import { useWizard } from './useWizard';

type Tool = 'currency' | 'units';
const TOOL_TITLES: Record<Tool, string> = { currency: 'Devises', units: 'Unités' };
const TOOL_DIALOG_WIDTH = 560;

export default function Convert(_props: FeatureViewProps) {
    const wizard = useWizard();
    const { state } = wizard;
    const canWrite = useWorkspacePermissions().canFeature('convert', 'write');
    const [tool, setTool] = useState<Tool | null>(null);

    const caps = useResource(
        'convert.capabilities',
        () => api.send('convert.capabilities', {}),
        'Impossible de savoir ce que ce serveur sait convertir.'
    );
    const list = useResource(
        'convert.list',
        () => api.send('convert.list', {}).then((r) => r.jobs),
        'Impossible de charger vos conversions.'
    );

    // L'avancement arrive par trames : elles animent la barre, la liste fait foi.
    const [live, setLive] = useState<ReadonlyMap<number, ConvertProgress>>(new Map());
    useEffect(
        () =>
            onServerEvent(CONVERT_PROGRESS_EVENT, convertProgressSchema, (frame) =>
                setLive((current) => new Map(current).set(frame.jobId, frame))
            ),
        []
    );

    const { file, kind } = state;
    const setInfo = wizard.setInfo;
    useEffect(() => {
        if (!file || !kind) return;
        let cancelled = false;
        void probeFile(file, kind).then((info) => {
            if (!cancelled) setInfo(info);
        });
        return () => {
            cancelled = true;
        };
    }, [file, kind, setInfo]);

    const source = kind && state.sourceId ? sourceOf(kind, state.sourceId) : null;
    const target = kind && state.sourceId && state.targetId ? targetOf(kind, state.sourceId, state.targetId) : null;
    const { sourceQuality = null, audioKbps = null, fps = null, width = null, height = null } = state.info ?? {};
    const specs = useMemo(
        () => (target ? adaptOptions(target, { sourceQuality, audioKbps, fps, width, height }) : []),
        [target, sourceQuality, audioKbps, fps, width, height]
    );
    const values = useMemo(() => resolveOptions(specs, state.values), [specs, state.values]);
    const { estimate, sample, pending } = useEstimate(target, values, state.info, file);

    const maxFileBytes = caps.data?.maxFileBytes ?? null;
    const fileProblem =
        file && maxFileBytes !== null && file.size > maxFileBytes
            ? `Ce fichier pèse ${formatBytesFr(file.size)} : la limite est de ${formatBytesFr(maxFileBytes)} par fichier.`
            : null;
    const ready = Boolean(file && source && target && !fileProblem);

    const [sending, setSending] = useState<Sending | null>(null);
    const [exportError, setExportError] = useState<string | null>(null);
    const upload = useRef<{ handle: UploadHandle; jobId: number } | null>(null);

    // Le travail né du dernier export. `seen` : la liste l'a déjà montré, si bien
    // que son absence veut dire « parti », et non « pas encore arrivé ».
    const [active, setActive] = useState<{ job: ConvertJob; seen: boolean } | null>(null);
    const listed = active ? list.data?.find((job) => job.id === active.job.id) : undefined;
    useEffect(() => {
        if (listed && active && !active.seen) setActive({ ...active, seen: true });
    }, [listed, active]);
    const tracked: Tracked | null = active
        ? {
              job: listed ?? active.job,
              progress: live.get(active.job.id),
              gone: active.seen && !listed && list.data !== null
          }
        : null;
    const locked = isLocked(sending, tracked);

    // Un export qui a échoué ou été annulé rend la main : dès qu'on quitte l'étape, son message s'efface.
    useEffect(() => {
        if (active && !locked && state.view !== 'export') setActive(null);
    }, [active, locked, state.view]);

    const startExport = async (): Promise<void> => {
        if (!file || !kind || !source || !target) return;
        setExportError(null);
        setSending({ stage: 'uploading', ratio: 0 });
        try {
            const created = await api.send('convert.create', {
                kind,
                sourceFormat: source.id,
                targetFormat: target.id,
                options: values,
                originalName: file.name,
                declaredBytes: file.size
            });
            invalidate('convert.list');
            const handle = uploadFile(created.uploadUrl, file, (ratio) =>
                setSending(ratio >= 1 ? { stage: 'verifying' } : { stage: 'uploading', ratio })
            );
            upload.current = { handle, jobId: created.job.id };
            setActive({ job: created.job, seen: false });
            await handle.done;
            // Le fichier est arrivé et vérifié : il attend son tour, quoi que la liste ait eu le temps de dire.
            setActive((current) => current && { ...current, job: { ...current.job, phase: 'queued' } });
        } catch (e) {
            setActive(null);
            const aborted = e instanceof UploadError && e.aborted;
            if (aborted && upload.current)
                void api.send('convert.cancel', { jobId: upload.current.jobId }).catch(() => undefined);
            if (!aborted)
                setExportError(
                    e instanceof UploadError ? e.message : humanizeError(e, 'La conversion n’a pas pu démarrer.')
                );
        } finally {
            upload.current = null;
            setSending(null);
            invalidate('convert.list');
        }
    };

    /** Rend vrai quand l'action a abouti. */
    const act = useCallback(async (run: () => Promise<unknown>, fallback: string): Promise<boolean> => {
        try {
            await run();
            return true;
        } catch (e) {
            setExportError(humanizeError(e, fallback));
            return false;
        } finally {
            invalidate('convert.list');
        }
    }, []);
    const onDownload = (job: ConvertJob): void =>
        void act(
            () => api.send('convert.download', { jobId: job.id }).then((r) => saveFrom(r.url)),
            'Ce résultat n’a pas pu être récupéré.'
        );
    const onCancel = (job: ConvertJob): void =>
        void act(() => api.send('convert.cancel', { jobId: job.id }), 'L’annulation a échoué.');
    const onRemove = (job: ConvertJob): void =>
        void act(() => api.send('convert.remove', { jobId: job.id }), 'Cette conversion n’a pas pu être retirée.');

    // Un travail annulé quitte la liste : l'écran revient à l'export, prêt à repartir, plutôt que de le chercher.
    const cancelActive = (): void => {
        if (!tracked) return;
        const jobId = tracked.job.id;
        void act(() => api.send('convert.cancel', { jobId }), 'L’annulation a échoué.').then((canceled) => {
            if (canceled) setActive(null);
        });
    };

    const startOver = (): void => {
        wizard.reset();
        setActive(null);
        setExportError(null);
    };

    const done = locked && tracked?.job.phase === 'done';
    const result: FileResult | null =
        done && file && target
            ? {
                  name: outputName(file.name, target),
                  bytes: tracked.job.outputBytes,
                  dims: state.info ? outputDims(target, values, state.info) : null,
                  label: target.label,
                  onDownload: () => onDownload(tracked.job)
              }
            : null;

    const steps: StepperStep[] = [
        { id: 'kinds', label: 'Type', reachable: !locked },
        { id: 'format', label: 'Format', reachable: kind !== null && !locked },
        { id: 'options', label: 'Options', reachable: ready && !locked },
        // On n'y entre que par le bouton Exporter de l'étape d'avant : y arriver, c'est avoir lancé l'export.
        { id: 'export', label: 'Export', reachable: state.view === 'export' }
    ];
    const family = caps.data?.families.find((f) => f.kind === kind);
    const atRoot = state.view === 'kinds' || kind === null;

    return (
        <div className={styles.root}>
            <div className={styles.header}>
                {!atRoot && (
                    <Button
                        variant='ghost'
                        icon='arrow-left'
                        disabled={sending !== null}
                        // Un export parti suit son cours sans cet écran : il reste dans la liste de l'accueil.
                        onClick={() => (active ? startOver() : wizard.open('kinds'))}
                    >
                        Tous les types
                    </Button>
                )}
                <h2 className={styles.title}>{atRoot ? manifest.label : `Convertir ${KIND_NOUNS[kindOf(kind).id]}`}</h2>
                <FeatureSettingsButton scope={{ kind: 'feature', feature: 'convert' }} />
            </div>

            <Stepper steps={steps} current={state.view} onGo={(id) => wizard.open(id as typeof state.view)} />
            {caps.error && (
                <p className={styles.problem} role='alert'>
                    {caps.error}
                </p>
            )}

            {atRoot ? (
                <KindStep
                    families={caps.data?.families ?? []}
                    onKind={wizard.pickKind}
                    onFile={wizard.pickFile}
                    onTool={setTool}
                />
            ) : (
                <div className={styles.workbench}>
                    <FilePane
                        wizard={wizard}
                        family={family}
                        target={target}
                        values={values}
                        sample={sample}
                        locked={locked}
                        result={result}
                    />
                    <div className={styles.stepPane}>
                        {state.view === 'format' && (
                            <FormatStep wizard={wizard} family={family} fileProblem={fileProblem} />
                        )}
                        {state.view === 'options' && target && (
                            <OptionsStep
                                wizard={wizard}
                                specs={specs}
                                estimate={estimate}
                                pending={pending}
                                canWrite={canWrite}
                                onExport={() => {
                                    wizard.open('export');
                                    void startExport();
                                }}
                            />
                        )}
                        {state.view === 'export' && source && target && (
                            <ExportStep
                                wizard={wizard}
                                source={source}
                                target={target}
                                estimate={estimate}
                                pending={pending}
                                sending={sending}
                                tracked={tracked}
                                error={exportError}
                                canWrite={canWrite}
                                resultTtlSeconds={caps.data?.resultTtlSeconds ?? null}
                                onExport={() => void startExport()}
                                onAbortUpload={() => upload.current?.handle.abort()}
                                onCancel={cancelActive}
                                onDownload={() => tracked && onDownload(tracked.job)}
                                onNew={startOver}
                            />
                        )}
                    </div>
                </div>
            )}

            {state.view !== 'export' && exportError && (
                <p className={styles.problem} role='alert'>
                    {exportError}
                </p>
            )}
            {/* À l'accueil, et une fois l'export terminé : entre les deux, la liste n'aide à rien. */}
            {(atRoot || done) && (
                <>
                    {list.error && <p className={styles.problem}>{list.error}</p>}
                    <JobList
                        // Le travail suivi est déjà à l'écran : il ne s'y montre pas deux fois.
                        jobs={(list.data ?? []).filter((job) => !(done && job.id === active?.job.id))}
                        live={live}
                        canWrite={canWrite}
                        onDownload={onDownload}
                        onCancel={onCancel}
                        onRemove={onRemove}
                    />
                </>
            )}

            <Dialog
                open={tool !== null}
                onClose={() => setTool(null)}
                title={tool ? TOOL_TITLES[tool] : undefined}
                width={TOOL_DIALOG_WIDTH}
            >
                {tool === 'currency' && <Currency />}
                {tool === 'units' && <Units />}
            </Dialog>
        </div>
    );
}
