import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    FeatureSettingsButton,
    formatBytesFr,
    humanizeError,
    invalidate,
    onServerEvent,
    useResource,
    useWorkspacePermissions
} from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';

import { sourceOf, targetOf } from '../contracts/catalogue';
import {
    CONVERT_PROGRESS_EVENT,
    convertProgressSchema,
    type ConvertJob,
    type ConvertProgress
} from '../contracts/domain';
import { resolveOptions } from '../contracts/options';
import { manifest } from '../manifest';
import { api } from './api';
import { Currency } from './Currency';
import { JobList } from './JobList';
import { probeFile } from './probe';
import { Stepper, type StepperStep } from './Stepper';
import { ExportStep, type Sending } from './steps/ExportStep';
import { FormatStep } from './steps/FormatStep';
import { KindStep } from './steps/KindStep';
import { OptionsStep } from './steps/OptionsStep';
import styles from './style.module.css';
import { Units } from './Units';
import { saveFrom, UploadError, uploadFile, type UploadHandle } from './upload';
import { useEstimate } from './useEstimate';
import { useWizard } from './useWizard';

const TITLES = { currency: 'Devises', units: 'Unités' } as const;

export default function Convert(_props: FeatureViewProps) {
    const wizard = useWizard();
    const { state } = wizard;
    const canWrite = useWorkspacePermissions().canFeature('convert', 'write');

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
    const values = useMemo(() => (target ? resolveOptions(target.options, state.values) : {}), [target, state.values]);
    const estimate = useEstimate(target, values, state.info, file);

    const maxFileBytes = caps.data?.maxFileBytes ?? null;
    const fileProblem =
        file && maxFileBytes !== null && file.size > maxFileBytes
            ? `Ce fichier pèse ${formatBytesFr(file.size)} : la limite est de ${formatBytesFr(maxFileBytes)} par fichier.`
            : null;
    const ready = Boolean(file && source && target && !fileProblem);

    const [sending, setSending] = useState<Sending | null>(null);
    const [exportError, setExportError] = useState<string | null>(null);
    const upload = useRef<{ handle: UploadHandle; jobId: number } | null>(null);

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
            await handle.done;
            wizard.reset();
        } catch (e) {
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

    const act = useCallback(async (run: () => Promise<unknown>, fallback: string): Promise<void> => {
        try {
            await run();
        } catch (e) {
            setExportError(humanizeError(e, fallback));
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

    const steps: StepperStep[] = [
        { id: 'kinds', label: 'Type', reachable: sending === null },
        { id: 'format', label: 'Format', reachable: kind !== null && sending === null },
        { id: 'options', label: 'Options', reachable: ready && sending === null },
        { id: 'export', label: 'Export', reachable: ready }
    ];
    const tool = state.view === 'currency' || state.view === 'units' ? state.view : null;

    return (
        <div className={styles.root}>
            <div className={styles.header}>
                <h2 className={styles.title}>{tool ? TITLES[tool] : manifest.label}</h2>
                <FeatureSettingsButton scope={{ kind: 'feature', feature: 'convert' }} />
            </div>

            {!tool && (
                <Stepper steps={steps} current={state.view} onGo={(id) => wizard.open(id as typeof state.view)} />
            )}
            {caps.error && (
                <p className={styles.problem} role='alert'>
                    {caps.error}
                </p>
            )}

            {state.view === 'kinds' && (
                <KindStep
                    families={caps.data?.families ?? []}
                    onKind={wizard.pickKind}
                    onFile={wizard.pickFile}
                    onTool={wizard.open}
                />
            )}
            {state.view === 'format' && (
                <FormatStep
                    wizard={wizard}
                    family={caps.data?.families.find((f) => f.kind === kind)}
                    fileProblem={fileProblem}
                />
            )}
            {state.view === 'options' && target && <OptionsStep wizard={wizard} target={target} estimate={estimate} />}
            {state.view === 'export' && source && target && (
                <ExportStep
                    wizard={wizard}
                    source={source}
                    target={target}
                    estimate={estimate}
                    sending={sending}
                    error={exportError}
                    canWrite={canWrite}
                    resultTtlSeconds={caps.data?.resultTtlSeconds ?? null}
                    onExport={() => void startExport()}
                    onAbort={() => upload.current?.handle.abort()}
                />
            )}
            {state.view === 'currency' && <Currency onBack={() => wizard.open('kinds')} />}
            {state.view === 'units' && <Units onBack={() => wizard.open('kinds')} />}

            {!tool && (
                <>
                    {state.view !== 'export' && exportError && (
                        <p className={styles.problem} role='alert'>
                            {exportError}
                        </p>
                    )}
                    {list.error && <p className={styles.problem}>{list.error}</p>}
                    <JobList
                        jobs={list.data ?? []}
                        live={live}
                        canWrite={canWrite}
                        onDownload={onDownload}
                        onCancel={onCancel}
                        onRemove={onRemove}
                    />
                </>
            )}
        </div>
    );
}
