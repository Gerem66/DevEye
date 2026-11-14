import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Button,
    ErrorNote,
    invalidate,
    openFeature,
    StatusBadge,
    useResource,
    useSubView,
    type ErrorNoteInput
} from 'deveye-sdk-client';

import type { ExposureAsset } from '../contracts/exposure';
import { EXPOSURE_FORMATS, FORMAT_FAMILY_LABEL, formatFamilySchema } from '../contracts/formats';

import { api } from './api';
import DetailPane from './DetailPane';
import { cveError } from './errors';
import { assetStatusLine, SOURCE_FEATURE, SOURCE_ICON, SOURCE_LABEL } from './exposureLabels';
import { useDetailAsPage } from './layout';
import styles from './style.module.css';

const FORMAT_LABEL = new Map(EXPOSURE_FORMATS.map((f) => [f.id, f.label]));

/** Ce que la veille lit de l'espace, élément par élément, et ce qu'elle sait lire. */
export default function InventoryView({
    canWrite,
    onDetailChange
}: {
    canWrite: boolean;
    onDetailChange: (open: boolean) => void;
}) {
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [busy, setBusy] = useState<number | null>(null);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const inventory = useResource(
        'cve.inventory',
        () => api.send('cve.inventory', {}),
        'L’inventaire n’a pas pu être lu.'
    );
    const assets = useMemo(() => inventory.data?.assets ?? [], [inventory.data]);
    const selected = assets.find((a) => a.id === selectedId) ?? null;
    const found = useMemo(() => new Set(assets.flatMap((a) => a.formats.map((f) => f.format))), [assets]);

    useSubView(selected ? 'asset' : null);
    useEffect(() => {
        onDetailChange(selected !== null);
        return () => onDetailChange(false);
    }, [selected, onDetailChange]);

    const act = useCallback(async (id: number, run: () => Promise<unknown>, fallback: string) => {
        setBusy(id);
        setError(null);
        try {
            await run();
            invalidate('cve.inventory', 'cve.exposure', 'cve.exposureCount');
        } catch (e) {
            setError(cveError(e, fallback));
        } finally {
            setBusy(null);
        }
    }, []);

    return (
        <>
            <div className={styles.listTools}>
                <p className={styles.status}>
                    {inventory.loading
                        ? 'Chargement…'
                        : `${assets.length} élément${assets.length > 1 ? 's' : ''} suivi${assets.length > 1 ? 's' : ''}.`}
                </p>
            </div>
            <ErrorNote note={error ?? inventory.error} />

            <div className={styles.split}>
                <div className={styles.listPane}>
                    {assets.length === 0 && !inventory.loading ? (
                        <p className={styles.empty}>
                            Aucun élément à lire. La veille suit les dépôts Git, les appareils, les bases et les
                            déploiements Dokploy de l’espace, dès qu’il y en a.
                        </p>
                    ) : (
                        <ul className={styles.list}>
                            {assets.map((a) => (
                                <AssetRow
                                    key={a.id}
                                    asset={a}
                                    selected={a.id === selectedId}
                                    onOpen={() => setSelectedId((cur) => (cur === a.id ? null : a.id))}
                                />
                            ))}
                        </ul>
                    )}

                    <section className={styles.formatsCard}>
                        <h3 className={styles.formatsTitle}>Formats reconnus</h3>
                        <p className={styles.formatsHint}>
                            Ce que la veille sait lire. Coché : l’espace en contient au moins un.
                        </p>
                        {formatFamilySchema.options.map((family) => (
                            <div key={family} className={styles.formatFamily}>
                                <h4 className={styles.detailSectionTitle}>{FORMAT_FAMILY_LABEL[family]}</h4>
                                <ul className={styles.formatList}>
                                    {EXPOSURE_FORMATS.filter((f) => f.family === family).map((f) => (
                                        <li
                                            key={f.id}
                                            className={`${styles.formatItem} ${found.has(f.id) ? styles.formatFound : ''}`}
                                            title={f.detail}
                                        >
                                            <span
                                                className={`icon ${found.has(f.id) ? 'icon-check-circle' : 'icon-x-circle'} ${styles.formatIcon}`}
                                                aria-hidden='true'
                                            />
                                            <span className={styles.formatName}>{f.label}</span>
                                            <span className={styles.formatDetail}>{f.detail}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </section>
                </div>

                <DetailPane open={selected !== null}>
                    {selected && (
                        <AssetDetail
                            asset={selected}
                            canWrite={canWrite}
                            busy={busy === selected.id}
                            onRefresh={() =>
                                void act(
                                    selected.id,
                                    () => api.send('cve.assetRefresh', { id: selected.id }),
                                    'La relecture n’a pas pu être demandée.'
                                )
                            }
                            onExclude={(excluded) =>
                                void act(
                                    selected.id,
                                    () => api.send('cve.assetExclude', { id: selected.id, excluded }),
                                    'L’élément n’a pas pu être changé.'
                                )
                            }
                            onClose={() => setSelectedId(null)}
                        />
                    )}
                </DetailPane>
            </div>
        </>
    );
}

function AssetRow({ asset, selected, onOpen }: { asset: ExposureAsset; selected: boolean; onOpen: () => void }) {
    const formats = [...new Set(asset.formats.map((f) => f.format))];
    return (
        <li className={`${styles.row} ${selected ? styles.rowSelected : ''}`}>
            <button type='button' className={styles.rowMain} onClick={onOpen}>
                <span className={styles.rowHead}>
                    <span className={`icon ${SOURCE_ICON[asset.source]} ${styles.assetChipIcon}`} aria-hidden='true' />
                    <span className={styles.rowId}>{asset.label}</span>
                    <span className={styles.rowAge}>{SOURCE_LABEL[asset.source]}</span>
                    {asset.status === 'error' && <StatusBadge tone='danger'>Lecture en échec</StatusBadge>}
                    {asset.openFindings > 0 && (
                        <StatusBadge tone='warning'>
                            {asset.openFindings} constat{asset.openFindings > 1 ? 's' : ''}
                        </StatusBadge>
                    )}
                </span>
                <span className={styles.rowSummary}>{assetStatusLine(asset)}</span>
                {formats.length > 0 && (
                    <span className={styles.rowFacts}>
                        {formats.map((f) => (
                            <span key={f} className={styles.assetChip}>
                                {FORMAT_LABEL.get(f) ?? f}
                            </span>
                        ))}
                    </span>
                )}
            </button>
        </li>
    );
}

function AssetDetail({
    asset,
    canWrite,
    busy,
    onRefresh,
    onExclude,
    onClose
}: {
    asset: ExposureAsset;
    canWrite: boolean;
    busy: boolean;
    onRefresh: () => void;
    onExclude: (excluded: boolean) => void;
    onClose: () => void;
}) {
    const asPage = useDetailAsPage();
    const detail = useResource(
        'cve.inventory',
        () => api.send('cve.asset', { id: asset.id }),
        'Les composants n’ont pas pu être lus.',
        [asset.id]
    );
    const components = detail.data?.components ?? [];

    return (
        <div className={styles.detail}>
            <header className={styles.detailHead}>
                <button
                    type='button'
                    className={styles.iconBtn}
                    onClick={onClose}
                    title={asPage ? 'Revenir à la liste' : 'Fermer la fiche'}
                    aria-label={asPage ? 'Revenir à la liste' : 'Fermer la fiche'}
                >
                    <span className={`icon ${asPage ? 'icon-arrow-left' : 'icon-x'}`} />
                </button>
                <h3 className={styles.detailTitle}>{asset.label}</h3>
                <button
                    type='button'
                    className={styles.iconBtn}
                    title={`Ouvrir dans ${SOURCE_LABEL[asset.source]}`}
                    aria-label={`Ouvrir dans ${SOURCE_LABEL[asset.source]}`}
                    onClick={() => openFeature(SOURCE_FEATURE[asset.source], asset.ref)}
                >
                    <span className='icon icon-move-to-right' />
                </button>
            </header>

            <p className={styles.detailSummary}>{assetStatusLine(asset)}</p>
            {asset.notes.map((n) => (
                <p key={n} className={styles.notice}>
                    <span className={`icon icon-warning ${styles.noticeIcon}`} aria-hidden='true' />
                    {n}
                </p>
            ))}

            <section className={styles.detailSection}>
                <h4 className={styles.detailSectionTitle}>Fichiers lus</h4>
                {asset.formats.length === 0 ? (
                    <p className={styles.detailMore}>Aucun fichier reconnu dans cet élément.</p>
                ) : (
                    <ul className={styles.affectedList}>
                        {asset.formats.map((f) => (
                            <li key={`${f.format}:${f.path}`} className={styles.affectedRow}>
                                <span className={styles.affectedText}>
                                    <span>{f.path ?? FORMAT_LABEL.get(f.format)}</span>
                                    <span className={styles.affectedWhere}>
                                        {f.count} composant{f.count > 1 ? 's' : ''}
                                    </span>
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section className={styles.detailSection}>
                <h4 className={styles.detailSectionTitle}>Composants ({components.length})</h4>
                <ul className={styles.componentList}>
                    {components.slice(0, 200).map((c) => (
                        <li key={`${c.kind}:${c.ecosystem}:${c.name}:${c.version}`} className={styles.componentRow}>
                            <span className={styles.componentName}>{c.name}</span>
                            <span className={styles.componentVersion}>{c.version}</span>
                            <span className={styles.componentEco}>{c.kind === 'package' ? c.ecosystem : 'outil'}</span>
                        </li>
                    ))}
                </ul>
                {components.length > 200 && <p className={styles.detailMore}>et {components.length - 200} autres</p>}
            </section>

            {canWrite && (
                <div className={styles.detailActions}>
                    {!asset.excluded && (
                        <Button variant='secondary' icon='refresh' disabled={busy} onClick={onRefresh}>
                            Relire
                        </Button>
                    )}
                    <Button variant='ghost' disabled={busy} onClick={() => onExclude(!asset.excluded)}>
                        {asset.excluded ? 'Remettre dans la veille' : 'Sortir de la veille'}
                    </Button>
                </div>
            )}
        </div>
    );
}
