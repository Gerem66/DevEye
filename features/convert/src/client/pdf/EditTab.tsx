import { useEffect, useState } from 'react';
import { ErrorNote, errorNote, invalidate, pickFiles, type ErrorNoteInput } from 'deveye-sdk-client';

import { api } from '../api';
import { addAsset } from './documents';
import {
    centredBox,
    clampToPage,
    DEFAULT_TEXT_SIZE,
    rectOf,
    replicate,
    textHeight,
    todayLabel,
    type InkColor,
    type PdfElement,
    type SignatureData
} from './elements';
import { HAND_FONT_FAMILY, loadHandFont } from './fonts';
import type { Point, Rect } from './geometry';
import { imageToPage } from './images';
import { Inspector } from './Inspector';
import { displayedSize, newId } from './model';
import styles from './pdf.module.css';
import { toStored, useSavedSignatures } from './savedSignatures';
import { handTextAspect } from './signatureImage';
import { SignatureDialog } from './SignatureDialog';
import { Stage } from './Stage';
import { ToolBar } from './ToolBar';
import type { Tool } from './tools';
import type { Workshop } from './usePdfWorkshop';

/** Les largeurs de ce qu'on pose d'un clic, en points. */
const SIGNATURE_WIDTH = 170;
const INITIALS_WIDTH = 64;
const TEXT_WIDTH = 220;
const DATE_WIDTH = 90;
const MARK_SIZE = 16;
const IMAGE_WIDTH = 200;
const INK_STROKE = 2;

type Role = 'signature' | 'initials';

interface EditTabProps {
    workshop: Workshop;
}

function aspectOf(data: SignatureData): number {
    switch (data.kind) {
        case 'path':
            return data.width / Math.max(data.height, 0.01);
        case 'text':
            return handTextAspect(data.text, HAND_FONT_FAMILY);
        case 'image':
            return data.width / Math.max(data.height, 1);
    }
}

/** Signer et annoter : une page à la fois, des outils, et les réglages de ce qui est choisi. */
export function EditTab({ workshop }: EditTabProps) {
    const { plan, elements, selection, act } = workshop;
    const [pageId, setPageId] = useState<string | null>(null);
    const page =
        plan.pages.find((p) => p.id === pageId) ??
        plan.pages.find((p) => p.id === selection[0]) ??
        plan.pages[0] ??
        null;
    const index = page ? plan.pages.findIndex((p) => p.id === page.id) : -1;
    const [tool, setToolState] = useState<Tool>('select');
    const [color, setColor] = useState<InkColor>('blue');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const selected = elements.find((e) => e.id === selectedId) ?? null;
    const [signatures, setSignatures] = useState<Record<Role, SignatureData | null>>({
        signature: null,
        initials: null
    });
    const [dialog, setDialog] = useState<Role | null>(null);
    const [pendingImage, setPendingImage] = useState<{ assetId: string; width: number; height: number } | null>(null);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const saved = useSavedSignatures();

    useEffect(() => {
        void loadHandFont();
    }, []);

    const keepOnAccount = async (role: Role, data: SignatureData): Promise<void> => {
        const stored = toStored(data);
        if (!stored) return;
        try {
            await api.send('convert.signatureSave', { role, data: stored });
        } catch (e) {
            setError(errorNote(e, 'La signature n’a pas pu être gardée sur votre compte.'));
        } finally {
            invalidate('convert.signatures');
        }
    };

    const removeSaved = async (id: number): Promise<void> => {
        try {
            await api.send('convert.signatureRemove', { id });
        } catch (e) {
            setError(errorNote(e, 'Cette signature n’a pas pu être retirée.'));
        } finally {
            invalidate('convert.signatures');
        }
    };

    const setTool = (next: Tool): void => {
        setError(null);
        if ((next === 'signature' || next === 'initials') && !signatures[next]) {
            setDialog(next);
            return;
        }
        if (next === 'image') {
            void pickFiles({ accept: 'image/*' }).then(async ([picked]) => {
                if (!picked) return;
                try {
                    const image = await imageToPage(picked.file);
                    setPendingImage({
                        assetId: addAsset(image.bytes, image.mime),
                        width: image.width,
                        height: image.height
                    });
                    setToolState('image');
                } catch (e) {
                    setError({ message: e instanceof Error ? e.message : 'Cette image ne se lit pas.', code: null });
                }
            });
            return;
        }
        setToolState(next);
    };

    const add = (element: PdfElement): void => {
        act('addElement', { element });
        setSelectedId(element.id);
        setToolState('select');
    };

    const stamp = (at: Point): void => {
        if (!page) return;
        const pageSize = displayedSize(page, plan);
        const base = { id: newId(), pageId: page.id, everyPage: false };
        switch (tool) {
            case 'signature':
            case 'initials': {
                const data = signatures[tool];
                if (!data) {
                    setDialog(tool);
                    return;
                }
                const width = tool === 'initials' ? INITIALS_WIDTH : SIGNATURE_WIDTH;
                const box = centredBox(at, { width, height: width / aspectOf(data) }, pageSize);
                add({ ...base, ...box, kind: 'signature', signature: data, color, everyPage: tool === 'initials' });
                return;
            }
            case 'text':
            case 'date': {
                const text = tool === 'date' ? todayLabel() : 'Texte';
                const size = DEFAULT_TEXT_SIZE;
                const box = clampToPage(
                    {
                        x: at.x,
                        y: at.y - size * 0.6,
                        width: tool === 'date' ? DATE_WIDTH : TEXT_WIDTH,
                        height: textHeight(text, size)
                    },
                    pageSize
                );
                add({ ...base, ...box, kind: 'text', text, size, color, hand: false });
                return;
            }
            case 'check':
            case 'cross': {
                const box = centredBox(at, { width: MARK_SIZE, height: MARK_SIZE }, pageSize);
                add({ ...base, ...box, kind: 'mark', mark: tool, color });
                return;
            }
            case 'image': {
                if (!pendingImage) return;
                const width = Math.min(IMAGE_WIDTH, pageSize.width / 2);
                const box = centredBox(
                    at,
                    { width, height: (width * pendingImage.height) / pendingImage.width },
                    pageSize
                );
                add({ ...base, ...box, kind: 'image', assetId: pendingImage.assetId });
                setPendingImage(null);
                return;
            }
            default:
                return;
        }
    };

    const draw = (kind: 'highlight' | 'box' | 'redact', rect: Rect): void => {
        if (!page) return;
        const base = { id: newId(), pageId: page.id, everyPage: false, ...rect };
        switch (kind) {
            case 'highlight':
                act('addElement', { element: { ...base, kind: 'highlight', color: 'yellow' } });
                break;
            case 'box':
                act('addElement', { element: { ...base, kind: 'box', fill: 'none', border: color } });
                break;
            case 'redact':
                act('addElement', { element: { ...base, kind: 'redact' } });
                break;
        }
        setSelectedId(base.id);
    };

    const ink = (path: string, box: Rect): void => {
        if (!page) return;
        const element: PdfElement = {
            id: newId(),
            pageId: page.id,
            everyPage: false,
            ...box,
            kind: 'ink',
            path,
            pathWidth: box.width,
            pathHeight: box.height,
            color,
            stroke: INK_STROKE
        };
        act('addElement', { element });
        setSelectedId(element.id);
    };

    const remove = (id: string): void => {
        act('removeElement', { id });
        if (selectedId === id) setSelectedId(null);
    };

    if (!page) return <p className={styles.note}>Ajoutez d’abord des pages.</p>;

    // Ce que les autres pages répètent ici : montré en transparence, à sa place, sans se laisser attraper.
    const pageSize = displayedSize(page, plan);
    const ghosts = elements
        .filter((e) => e.everyPage && e.pageId !== page.id && e.kind !== 'redact')
        .map((e) => {
            const origin = plan.pages.find((p) => p.id === e.pageId);
            return { ...e, ...replicate(rectOf(e), origin ? displayedSize(origin, plan) : pageSize, pageSize) };
        });

    return (
        <div className={styles.editTab}>
            <ToolBar
                index={index}
                count={plan.pages.length}
                onGo={(i) => {
                    setPageId(plan.pages[i]?.id ?? null);
                    setSelectedId(null);
                }}
                tool={tool}
                onTool={setTool}
                color={color}
                onColor={setColor}
            />
            <ErrorNote note={error} inline onDismiss={() => setError(null)} />
            <ErrorNote note={saved.error} inline />
            <div className={styles.editBody}>
                <Stage
                    page={page}
                    plan={plan}
                    elements={elements.filter((e) => e.pageId === page.id)}
                    ghosts={ghosts}
                    selectedId={selectedId}
                    tool={tool}
                    onSelect={setSelectedId}
                    onStamp={stamp}
                    onDraw={draw}
                    onInk={ink}
                    onUpdate={(id, rect) => act('updateElement', { id, patch: rect })}
                    onRemove={remove}
                />
                <Inspector
                    element={selected}
                    tool={tool}
                    onChange={(patch) => selected && act('updateElement', { id: selected.id, patch })}
                    onRemove={() => selected && remove(selected.id)}
                    onChangeSignature={setDialog}
                />
            </div>
            <SignatureDialog
                role={dialog}
                saved={saved.signatures}
                onClose={() => setDialog(null)}
                onRemoveSaved={(id) => void removeSaved(id)}
                onPick={(data, keep) => {
                    if (dialog) {
                        setSignatures((s) => ({ ...s, [dialog]: data }));
                        setToolState(dialog);
                        if (keep) void keepOnAccount(dialog, data);
                    }
                    setDialog(null);
                }}
            />
        </div>
    );
}
