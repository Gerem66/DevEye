import { useEffect, useRef, useState } from 'react';
import {
    ConfirmDialog,
    ErrorNote,
    errorNote,
    invalidate,
    pickFiles,
    type ConfirmRequest,
    type ErrorNoteInput
} from 'deveye-sdk-client';

import type { SavedSignature, SignatureRole } from '../contracts/signatures';
import { api } from './api';
import { addAsset } from './documents';
import {
    BOX_STROKE,
    centredBox,
    clampToPage,
    DEFAULT_TEXT_SIZE,
    rectOf,
    replicate,
    textHeight,
    todayLabel,
    type HexColor,
    type Ink,
    type PdfElement,
    type SignatureData
} from './elements';
import { HAND_FONT_FAMILY, loadHandFont } from './fonts';
import type { Point, Rect } from './geometry';
import { imageToPage } from './images';
import type { InkSlots } from './InkPicker';
import { Inspector } from './Inspector';
import { displayedSize, newId } from './model';
import styles from './pdf.module.css';
import { usePrefs } from './prefs';
import { fromStored, toStored, useSavedSignatures } from './savedSignatures';
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

type Role = SignatureRole;

/** La signature ou le paraphe en main : ce qu'on pose, et d'où il vient quand c'est du compte. */
interface InHand {
    data: SignatureData;
    savedId: number | null;
}

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
    const [color, setColor] = useState<Ink>('blue');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const selected = elements.find((e) => e.id === selectedId) ?? null;
    const [signatures, setSignatures] = useState<Record<Role, InHand | null>>({ signature: null, initials: null });
    const [dialog, setDialog] = useState<Role | null>(null);
    /** Où poser la signature que le dialogue va rendre, quand c'est un clic sur la page qui l'a ouvert. */
    const pendingStamp = useRef<Point | null>(null);
    const [pendingImage, setPendingImage] = useState<{ assetId: string; width: number; height: number } | null>(null);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const saved = useSavedSignatures();
    const { prefs, save } = usePrefs();
    // Les encres libres, tenues ici le temps que le compte les écrive.
    const [custom, setCustom] = useState<readonly (HexColor | null)[] | null>(null);
    const inks: InkSlots = {
        custom: custom ?? prefs.inks,
        onCustomChange: (index, hex) => {
            const next = (custom ?? prefs.inks).map((c, i) => (i === index ? hex : c));
            setCustom(next);
            save({ inks: next });
        }
    };

    useEffect(() => {
        void loadHandFont();
    }, []);

    // Celle choisie la dernière fois revient en main, dès que le compte a répondu.
    useEffect(() => {
        if (!saved.signatures) return;
        for (const role of ['signature', 'initials'] as const) {
            const match = saved.signatures.find((s) => s.role === role && s.id === prefs[role]);
            if (!match) continue;
            setSignatures((cur) =>
                cur[role] ? cur : { ...cur, [role]: { data: fromStored(match.data), savedId: match.id } }
            );
        }
    }, [saved.signatures, prefs]);

    /** Une signature du compte passe en main et devient le choix du compte. */
    const takeSaved = (role: Role, chosen: SavedSignature): InHand => {
        const inHand = { data: fromStored(chosen.data), savedId: chosen.id };
        setSignatures((cur) => ({ ...cur, [role]: inHand }));
        save({ [role]: chosen.id });
        return inHand;
    };

    const pickSaved = (role: Role, chosen: SavedSignature): void => {
        takeSaved(role, chosen);
        setSelectedId(null);
        setToolState(role);
    };

    /** La signature choisie sur la page en reproduit une autre, qui passe aussi en main. */
    const swapSignature = (chosen: SavedSignature): void => {
        if (selected?.kind !== 'signature') return;
        const { data, savedId } = takeSaved(selected.role, chosen);
        act('updateElement', {
            id: selected.id,
            patch: { signature: data, savedId, height: selected.width / aspectOf(data) }
        });
    };

    /** Garde sur le compte ; l'id rendu, ou `null` si ça n'a pas pu se faire. */
    const keepOnAccount = async (role: Role, data: SignatureData): Promise<number | null> => {
        const stored = toStored(data);
        if (!stored) return null;
        try {
            const { signature } = await api.send('pdf.signatureSave', { role, data: stored });
            return signature.id;
        } catch (e) {
            setError(errorNote(e, 'La signature n’a pas pu être gardée sur votre compte.'));
            return null;
        } finally {
            invalidate('pdf.signatures');
        }
    };

    const removeSaved = async (id: number): Promise<void> => {
        try {
            await api.send('pdf.signatureRemove', { id });
        } catch (e) {
            setError(errorNote(e, 'Cette signature n’a pas pu être retirée.'));
        } finally {
            invalidate('pdf.signatures');
        }
        // Retirée du compte, elle n'est plus en main : le prochain clic en fait une autre.
        for (const role of ['signature', 'initials'] as const) {
            if (signatures[role]?.savedId !== id) continue;
            setSignatures((cur) => ({ ...cur, [role]: null }));
            save({ [role]: null });
        }
    };

    const askRemoveSaved = (id: number): void => {
        const role = saved.signatures?.find((s) => s.id === id)?.role;
        setConfirm({
            title: role === 'initials' ? 'Retirer ce paraphe ?' : 'Retirer cette signature ?',
            description: 'Il disparaît de votre compte. Ce qui est déjà posé sur les pages reste.',
            confirmLabel: 'Retirer',
            onConfirm: () => void removeSaved(id)
        });
    };

    /**
     * Une signature neuve passe en main tout de suite, et se pose là où le clic
     * l'attendait ; gardée, elle devient aussi le choix du compte, élément posé
     * compris.
     */
    const newSignature = async (role: Role, data: SignatureData, keep: boolean): Promise<void> => {
        setSignatures((cur) => ({ ...cur, [role]: { data, savedId: null } }));
        const at = pendingStamp.current;
        pendingStamp.current = null;
        const placed = at ? placeSignature(role, { data, savedId: null }, at) : null;
        if (!keep) return;
        const savedId = await keepOnAccount(role, data);
        if (savedId === null) return;
        setSignatures((cur) => (cur[role]?.data === data ? { ...cur, [role]: { data, savedId } } : cur));
        if (placed) act('updateElement', { id: placed, patch: { savedId } });
        save({ [role]: savedId });
    };

    const setTool = (next: Tool): void => {
        setError(null);
        // Un outil choisi en haut ne garde rien de choisi sur la page : l'inspecteur parle de l'outil.
        if (next !== 'select') setSelectedId(null);
        if ((next === 'signature' || next === 'initials') && !signatures[next]) {
            // Rien en main : la première gardée fait l'affaire ; sans aucune, le clic sur la page en fera une.
            const first = saved.signatures?.find((s) => s.role === next);
            if (first) takeSaved(next, first);
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

    /** Pose la signature en main à un point de la page ; l'id de l'élément posé. */
    const placeSignature = (role: Role, inHand: InHand, at: Point): string | null => {
        if (!page) return null;
        const pageSize = displayedSize(page, plan);
        const width = role === 'initials' ? INITIALS_WIDTH : SIGNATURE_WIDTH;
        const box = centredBox(at, { width, height: width / aspectOf(inHand.data) }, pageSize);
        const element: PdfElement = {
            id: newId(),
            pageId: page.id,
            everyPage: false,
            ...box,
            kind: 'signature',
            role,
            signature: inHand.data,
            savedId: inHand.savedId,
            color
        };
        add(element);
        return element.id;
    };

    const stamp = (at: Point): void => {
        if (!page) return;
        const pageSize = displayedSize(page, plan);
        const base = { id: newId(), pageId: page.id, everyPage: false };
        switch (tool) {
            case 'signature':
            case 'initials': {
                const inHand = signatures[tool];
                if (!inHand) {
                    // Rien en main : on en fait une, qui se posera ici.
                    pendingStamp.current = at;
                    setDialog(tool);
                    return;
                }
                placeSignature(tool, inHand, at);
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

    // Ce qui vient d'être tracé est choisi, outil Sélection en main : on le règle, on ne retrace pas.
    const draw = (kind: 'highlight' | 'box' | 'redact', rect: Rect): void => {
        if (!page) return;
        const base = { id: newId(), pageId: page.id, everyPage: false, ...rect };
        switch (kind) {
            case 'highlight':
                add({ ...base, kind: 'highlight', color: 'yellow' });
                break;
            case 'box':
                add({ ...base, kind: 'box', fill: 'none', border: color, stroke: BOX_STROKE });
                break;
            case 'redact':
                add({ ...base, kind: 'redact' });
                break;
        }
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
        add(element);
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
                inks={inks}
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
                    ink={color}
                    onSelect={setSelectedId}
                    onStamp={stamp}
                    onDraw={draw}
                    onInk={ink}
                    onUpdate={(id, rect) => act('updateElement', { id, patch: rect })}
                    onEditText={(id, text) => {
                        const el = elements.find((e) => e.id === id);
                        if (el?.kind === 'text')
                            act('updateElement', { id, patch: { text, height: textHeight(text, el.size) } });
                    }}
                    onRemove={remove}
                />
                <Inspector
                    element={selected}
                    tool={tool}
                    onChange={(patch) => selected && act('updateElement', { id: selected.id, patch })}
                    onRemove={() => selected && remove(selected.id)}
                    library={{
                        saved: saved.signatures,
                        current: {
                            signature: signatures.signature?.savedId ?? null,
                            initials: signatures.initials?.savedId ?? null
                        },
                        onPick: pickSaved,
                        onRemove: askRemoveSaved,
                        onNew: setDialog
                    }}
                    onSwapSignature={swapSignature}
                    inks={inks}
                />
            </div>
            <SignatureDialog
                role={dialog}
                savedCount={saved.signatures?.length ?? 0}
                onClose={() => {
                    pendingStamp.current = null;
                    setDialog(null);
                }}
                onPick={(data, keep) => {
                    if (dialog) {
                        setToolState(dialog);
                        void newSignature(dialog, data, keep);
                    }
                    setDialog(null);
                }}
            />
            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
        </div>
    );
}
