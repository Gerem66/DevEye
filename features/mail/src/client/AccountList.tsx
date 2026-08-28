import { useCallback, useEffect, useRef, useState } from 'react';

import AccountCard from './AccountCard';
import styles from './style.module.css';

import type { MailAccount } from '../contracts/domain';

interface AccountListProps {
    accounts: MailAccount[];
    selectedId: number | null;
    busy: ReadonlySet<number>;
    onOpen: (account: MailAccount) => void;
    onEdit: (account: MailAccount) => void;
    onToggle: (account: MailAccount) => void;
    /** The complete new order after a drop. */
    onReorder: (ids: number[]) => void;
    /** A drag started or ended — the host pauses its polling meanwhile. */
    onDragStateChange: (dragging: boolean) => void;
}

/** Pointer movement, in px, before a press commits to a drag rather than a click. */
const DRAG_THRESHOLD = 6;

/** Half the list's row gap, where the insertion bar is centred. */
function halfGap(list: HTMLElement): number {
    return (parseFloat(getComputedStyle(list).rowGap) || 0) / 2;
}

/** The order `ids` become when `draggedId` lands in gap `gap`, or null if unchanged. */
function reordered(accounts: MailAccount[], draggedId: number, gap: number): number[] | null {
    const from = accounts.findIndex((a) => a.id === draggedId);
    if (from === -1) return null;
    const rest = accounts.filter((a) => a.id !== draggedId);
    rest.splice(from < gap ? gap - 1 : gap, 0, accounts[from]);
    const ids = rest.map((a) => a.id);
    return ids.every((id, i) => id === accounts[i].id) ? null : ids;
}

/**
 * The account list, with drag & drop ordering — same pointer-events technique
 * as `features/uptime/src/client/ServiceList` (see that file for why HTML5 `draggable`
 * is deliberately avoided).
 */
export function AccountList({
    accounts,
    selectedId,
    busy,
    onOpen,
    onEdit,
    onToggle,
    onReorder,
    onDragStateChange
}: AccountListProps) {
    const listRef = useRef<HTMLDivElement>(null);
    const barRef = useRef<HTMLSpanElement>(null);
    const gapRef = useRef<number | null>(null);
    const pressRef = useRef<{ id: number; pointerId: number; x: number; y: number } | null>(null);
    const draggedRef = useRef<number | null>(null);
    const [draggedId, setDraggedId] = useState<number | null>(null);
    const suppressClickRef = useRef(false);

    const rowEls = useCallback(
        () => Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-account-card]') ?? []),
        []
    );

    const hideBar = useCallback(() => {
        gapRef.current = null;
        if (barRef.current) barRef.current.style.opacity = '0';
    }, []);

    const showBar = useCallback(
        (index: number) => {
            const list = listRef.current;
            const bar = barRef.current;
            if (!list || !bar || gapRef.current === index) return;
            const rows = rowEls();
            if (rows.length === 0) return;

            const boxes = rows.map((el) => el.getBoundingClientRect());
            let centre: number;
            if (index <= 0) centre = boxes[0].top - halfGap(list);
            else if (index >= boxes.length) centre = boxes[boxes.length - 1].bottom + halfGap(list);
            else centre = (boxes[index - 1].bottom + boxes[index].top) / 2;

            gapRef.current = index;
            const listBox = list.getBoundingClientRect();
            bar.style.transform = `translateY(${centre - listBox.top - bar.offsetHeight / 2}px)`;
            bar.style.opacity = '1';
        },
        [rowEls]
    );

    const gapAt = useCallback(
        (clientY: number): number => {
            let best = 0;
            let bestDistance = Infinity;
            for (const [i, el] of rowEls().entries()) {
                const box = el.getBoundingClientRect();
                for (const [y, gap] of [
                    [box.top, i],
                    [box.bottom, i + 1]
                ]) {
                    const distance = Math.abs(clientY - y);
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        best = gap;
                    }
                }
            }
            return best;
        },
        [rowEls]
    );

    const showBarRef = useRef(showBar);
    showBarRef.current = showBar;
    const gapAtRef = useRef(gapAt);
    gapAtRef.current = gapAt;
    const accountsRef = useRef(accounts);
    accountsRef.current = accounts;
    const onReorderRef = useRef(onReorder);
    onReorderRef.current = onReorder;
    const onDragStateChangeRef = useRef(onDragStateChange);
    onDragStateChangeRef.current = onDragStateChange;

    /**
     * Every window handler below is `useCallback(..., [])`, i.e. one identity
     * for the component's whole lifetime, and reads everything it needs
     * through a ref. This is load-bearing, not tidiness: handlers re-created
     * per render (a plain `function` in the body) make `removeEventListener`
     * a no-op, so a drag that outlives a single render leaves its
     * `pointermove` listener subscribed forever — and each of those runs
     * `getBoundingClientRect()` over every card on every pointer move, which
     * is what eventually wedged the whole page. Stable identities also make
     * `addEventListener` idempotent, so a re-entrant press can't double-subscribe.
     */
    const endDragRef = useRef<() => void>(() => {});

    const handleWindowPointerMove = useCallback((e: PointerEvent) => {
        const press = pressRef.current;
        if (!press || e.pointerId !== press.pointerId) return;
        if (draggedRef.current === null) {
            if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD) return;
            draggedRef.current = press.id;
            setDraggedId(press.id);
            onDragStateChangeRef.current(true);
            document.body.style.cursor = 'grabbing';
            document.body.style.userSelect = 'none';
        }
        showBarRef.current(gapAtRef.current(e.clientY));
    }, []);

    const handleWindowPointerUp = useCallback((e: PointerEvent) => {
        const press = pressRef.current;
        if (!press || e.pointerId !== press.pointerId) return;
        const dragged = draggedRef.current;
        const gap = gapRef.current;
        if (dragged !== null) suppressClickRef.current = true;
        endDragRef.current();
        if (dragged !== null && gap !== null) {
            const ids = reordered(accountsRef.current, dragged, gap);
            if (ids) onReorderRef.current(ids);
        }
    }, []);

    const handleWindowPointerCancel = useCallback((e: PointerEvent) => {
        if (pressRef.current?.pointerId !== e.pointerId) return;
        endDragRef.current();
    }, []);

    const handleWindowBlur = useCallback(() => {
        endDragRef.current();
    }, []);

    const handleWindowKeyDown = useCallback((e: KeyboardEvent) => {
        if (e.key === 'Escape') endDragRef.current();
    }, []);

    const endDrag = useCallback(() => {
        window.removeEventListener('pointermove', handleWindowPointerMove);
        window.removeEventListener('pointerup', handleWindowPointerUp);
        window.removeEventListener('pointercancel', handleWindowPointerCancel);
        window.removeEventListener('blur', handleWindowBlur);
        window.removeEventListener('keydown', handleWindowKeyDown);
        hideBar();
        document.body.style.removeProperty('cursor');
        document.body.style.removeProperty('user-select');
        pressRef.current = null;
        if (draggedRef.current !== null) {
            draggedRef.current = null;
            setDraggedId(null);
            onDragStateChangeRef.current(false);
        }
    }, [
        hideBar,
        handleWindowPointerMove,
        handleWindowPointerUp,
        handleWindowPointerCancel,
        handleWindowBlur,
        handleWindowKeyDown
    ]);
    endDragRef.current = endDrag;

    // Unmount only. Tying this to `endDrag`'s identity is what used to abort a
    // drag the instant anything re-rendered the list — including the host's
    // own sync-progress poll, every 1.5s.
    useEffect(() => () => endDragRef.current(), []);

    function handlePointerDown(e: React.PointerEvent, accountId: number) {
        if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
        pressRef.current = { id: accountId, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
        window.addEventListener('pointermove', handleWindowPointerMove);
        window.addEventListener('pointerup', handleWindowPointerUp);
        window.addEventListener('pointercancel', handleWindowPointerCancel);
        window.addEventListener('blur', handleWindowBlur);
        window.addEventListener('keydown', handleWindowKeyDown);
    }

    return (
        <div ref={listRef} className={styles.accountList}>
            {accounts.map((account) => (
                <AccountCard
                    key={account.id}
                    account={account}
                    selected={selectedId === account.id}
                    busy={busy.has(account.id)}
                    dragging={draggedId === account.id}
                    onOpen={() => {
                        if (suppressClickRef.current) {
                            suppressClickRef.current = false;
                            return;
                        }
                        onOpen(account);
                    }}
                    onEdit={() => onEdit(account)}
                    onToggle={() => onToggle(account)}
                    onDragPointerDown={(e) => handlePointerDown(e, account.id)}
                />
            ))}
            <span ref={barRef} className={styles.dropBar} aria-hidden='true' />
        </div>
    );
}

export default AccountList;
