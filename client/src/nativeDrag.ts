/**
 * Refuse every native HTML5 drag the app didn't explicitly ask for.
 *
 * The browser makes drag sources out of things nobody declared: every `<a>`,
 * every `<img>`, and any selected text. On Chromium/Linux an interrupted drag
 * session leaves the browser convinced one is still under way, swallowing clicks,
 * hover and the context menu, and nothing in the page can recover from it. Hence
 * pointer events for our own drags, and this for the ones the browser provides
 * for free.
 *
 * Opting in stays explicit: a `draggable="true"` attribute anywhere up the tree
 * lets the drag through. The attribute, not the property, which anchors and
 * images report as true on their own.
 *
 * Only drags starting in the page are refused. Dragging a file in from outside
 * fires `dragover`/`drop`, never `dragstart`, and is untouched.
 */
export function suppressNativeDrags(): void {
    document.addEventListener('dragstart', (e) => {
        const target = e.target;
        if (target instanceof Element && target.closest('[draggable="true"]')) return;
        e.preventDefault();
    });
}
