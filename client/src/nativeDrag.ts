/**
 * Refuse every native HTML5 drag the app didn't explicitly ask for.
 *
 * The browser makes drag sources out of things nobody declared: every `<a>`,
 * every `<img>`, and any text the user happens to have selected. On the home
 * grid alone that covers each shortcut tile — Widget renders as an anchor as
 * soon as it has an `href`, and ShortcutTile puts a favicon and a logo inside
 * it — so dragging the pointer across the dashboard, or across a selection, is
 * enough to open a drag session no code of ours started.
 *
 * That matters because of how such a session can end on this platform. On
 * Chromium/Linux an interrupted one leaves the browser convinced a drag is
 * still under way: it swallows clicks, hover, the context menu, even the click
 * that would clear the selection, while the page keeps rendering behind the
 * freeze. Nothing in the page can recover from it — no event arrives to recover
 * with — which is why Uptime and Mail were written on pointer events instead of
 * the native API (see {@link ./Features/Uptime/ServiceList}). Those rewrites
 * fixed our own drags; this covers the ones the browser provides for free, and
 * every feature written from here on with them.
 *
 * Opting in stays possible, and stays explicit: a `draggable="true"` attribute
 * anywhere up the tree lets the drag through. The attribute, not the property —
 * anchors and images report `draggable === true` on their own, so the property
 * cannot tell an intention from a default. Notes reorders its cards and blocks
 * that way and is unaffected.
 *
 * Only drags *starting* in the page are refused. Dragging something in from
 * outside (a file onto a drop zone) fires `dragover`/`drop`, never `dragstart`,
 * and is untouched.
 */
export function suppressNativeDrags(): void {
    document.addEventListener('dragstart', (e) => {
        const target = e.target;
        if (target instanceof Element && target.closest('[draggable="true"]')) return;
        e.preventDefault();
    });
}
