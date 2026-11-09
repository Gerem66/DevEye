import { useEffect, useState } from 'react';
import { Button, CopyButton, saveFrom } from 'deveye-sdk-client';

import { pageText } from './documents';
import { outputName, sourceOf, type Plan } from './model';
import styles from './pdf.module.css';
import type { Workshop } from './usePdfWorkshop';

const BLOB_URL_TTL_MS = 60_000;

/** Le texte de chaque page du document, dans l'ordre du plan. `null` : pas encore lu. */
function useTexts(plan: Plan): ReadonlyMap<string, string | null> {
    const [texts, setTexts] = useState<ReadonlyMap<string, string | null>>(new Map());
    useEffect(() => {
        let cancelled = false;
        (async () => {
            for (const page of plan.pages) {
                if (cancelled) return;
                if (texts.has(page.id)) continue;
                const text = page.kind === 'source' ? await pageText(page.sourceId, page.index).catch(() => '') : '';
                if (cancelled) return;
                setTexts((t) => new Map(t).set(page.id, text));
            }
        })();
        return () => {
            cancelled = true;
        };
        // Une page déjà lue ne se relit pas ; seules les nouvelles pages déclenchent une lecture.
    }, [plan, texts]);
    return texts;
}

interface TextTabProps {
    workshop: Workshop;
    /** Faire reconnaître le texte des pages scannées par le serveur ; `null` quand il ne le propose pas. */
    onOcr: (() => void) | null;
}

/** Le texte du document, page par page, à copier ou à télécharger. */
export function TextTab({ workshop, onOcr }: TextTabProps) {
    const { plan } = workshop;
    const texts = useTexts(plan);
    const read = plan.pages.filter((p) => texts.get(p.id) !== undefined && texts.get(p.id) !== null).length;
    const withText = plan.pages.filter((p) => (texts.get(p.id) ?? '') !== '').length;
    const scanned = plan.pages.filter((p) => p.kind === 'source' && texts.get(p.id) === '').length;
    const all = plan.pages
        .map((p, i) => `Page ${i + 1}\n\n${texts.get(p.id) ?? ''}`)
        .join('\n\n\n')
        .trim();

    const download = (): void => {
        const url = URL.createObjectURL(new Blob([all], { type: 'text/plain;charset=utf-8' }));
        saveFrom(url, outputName(plan).replace(/\.pdf$/, '.txt'));
        window.setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_TTL_MS);
    };

    return (
        <div className={styles.editTab}>
            <div className={styles.toolbar}>
                <span className={styles.toolbarText}>
                    {read < plan.pages.length
                        ? `Lecture du texte : ${read} / ${plan.pages.length} pages…`
                        : withText === 0
                          ? 'Aucun texte dans ce document : des images, ou un scan.'
                          : `${withText} page${withText > 1 ? 's' : ''} avec du texte sur ${plan.pages.length}.`}
                </span>
                <div className={styles.toolbarEnd}>
                    {onOcr && scanned > 0 && read === plan.pages.length && (
                        <Button
                            variant='secondary'
                            icon='upload'
                            title='Le document part sur le serveur, qui lit les pages scannées'
                            onClick={onOcr}
                        >
                            Reconnaître le texte sur le serveur
                        </Button>
                    )}
                    <CopyButton value={all} label='Copier tout le texte' className={styles.iconButton} />
                    <Button variant='secondary' icon='download' disabled={all === ''} onClick={download}>
                        Télécharger en .txt
                    </Button>
                </div>
            </div>
            <div className={styles.textPages}>
                {plan.pages.map((page, i) => {
                    const text = texts.get(page.id);
                    const origin = page.kind === 'source' ? sourceOf(plan, page.sourceId)?.name : null;
                    return (
                        <section key={page.id} className={styles.textPage} aria-label={`Page ${i + 1}`}>
                            <h4 className={styles.textHead}>
                                Page {i + 1}
                                {origin && <span className={styles.textOrigin}> · {origin}</span>}
                            </h4>
                            {text === undefined || text === null ? (
                                <p className={styles.note}>Lecture…</p>
                            ) : text === '' ? (
                                <p className={styles.note}>
                                    {page.kind === 'source'
                                        ? 'Aucun texte sur cette page : une image, ou un scan.'
                                        : 'Une page sans texte.'}
                                </p>
                            ) : (
                                <pre className={styles.textBlock}>{text}</pre>
                            )}
                        </section>
                    );
                })}
            </div>
        </div>
    );
}
