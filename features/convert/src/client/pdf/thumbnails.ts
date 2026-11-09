import { imageBytes, pageOf } from './documents';
import { PAPER } from './images';
import { displayedSize, imageOf, totalRotation, type Plan, type PlanPage } from './model';
import { renderPage } from './pdfjs';

/**
 * Les vignettes des pages : rendues deux par deux, la plus récemment demandée
 * d'abord (c'est celle qui est à l'écran), gardées en adresses `blob:` tant
 * qu'il y a de la place.
 */

const CONCURRENCY = 2;
const CACHE_MAX = 500;

const cache = new Map<string, Promise<string>>();
let running = 0;
const waiting: Array<() => void> = [];

function slot(): Promise<void> {
    if (running < CONCURRENCY) {
        running++;
        return Promise.resolve();
    }
    return new Promise((resolve) =>
        waiting.unshift(() => {
            running++;
            resolve();
        })
    );
}

function release(): void {
    running--;
    waiting.shift()?.();
}

function keyOf(page: PlanPage, plan: Plan, width: number): string {
    const what =
        page.kind === 'source'
            ? `${page.sourceId}/${page.index}`
            : page.kind === 'image'
              ? `img/${page.imageId}`
              : `blank/${page.width}x${page.height}`;
    return `${what}@${totalRotation(page, plan)}:${width}`;
}

function drawRotated(
    ctx: CanvasRenderingContext2D,
    bitmap: ImageBitmap,
    rotation: number,
    width: number,
    height: number
): void {
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    const [w, h] = rotation % 180 === 0 ? [width, height] : [height, width];
    ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
    ctx.restore();
}

async function paint(page: PlanPage, plan: Plan, width: number): Promise<string> {
    const pixelWidth = Math.round(width * Math.min(window.devicePixelRatio || 1, 2));
    const canvas = document.createElement('canvas');
    const rotation = totalRotation(page, plan);
    if (page.kind === 'source') {
        const proxy = await pageOf(page.sourceId, page.index);
        if (!proxy) throw new Error('Page introuvable.');
        await renderPage(proxy, canvas, pixelWidth, rotation);
    } else {
        const size = displayedSize(page, plan);
        canvas.width = pixelWidth;
        canvas.height = Math.max(1, Math.round((pixelWidth * size.height) / size.width));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Le navigateur ne fournit pas de canevas.');
        ctx.fillStyle = PAPER;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (page.kind === 'image') {
            const bytes = imageBytes(page.imageId);
            const info = imageOf(plan, page.imageId);
            if (bytes && info) {
                const bitmap = await createImageBitmap(new Blob([bytes], { type: info.mime }));
                drawRotated(ctx, bitmap, rotation, canvas.width, canvas.height);
                bitmap.close();
            }
        }
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('La vignette n’a pas pu être dessinée.');
    return URL.createObjectURL(blob);
}

const revoke = (url: Promise<string>): void => void url.then((u) => URL.revokeObjectURL(u)).catch(() => undefined);

export function thumbnail(page: PlanPage, plan: Plan, width: number): Promise<string> {
    const key = keyOf(page, plan, width);
    const hit = cache.get(key);
    if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
    }
    const url = (async () => {
        await slot();
        try {
            return await paint(page, plan, width);
        } finally {
            release();
        }
    })();
    cache.set(key, url);
    url.catch(() => cache.delete(key));
    if (cache.size > CACHE_MAX) {
        const oldest = cache.entries().next().value;
        if (oldest) {
            cache.delete(oldest[0]);
            revoke(oldest[1]);
        }
    }
    return url;
}

export function clearThumbnails(): void {
    for (const url of cache.values()) revoke(url);
    cache.clear();
}
