import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
    cancelTask,
    chipOf,
    clearFinished,
    dismissTask,
    foregroundOf,
    getTaskRecords,
    hasLocalWork,
    LOST_NOTE,
    matchRunning,
    minimizeTask,
    onTasksChange,
    PROGRESS_GAP_MS,
    raiseTask,
    resetTasks,
    setPanelOpen,
    SILENT_NOTE,
    startTask,
    stepOf,
    TaskError,
    zoneOf,
    type TaskContext,
    type TaskSpec
} from './tasks';

const HERE = { instanceId: null, workspaceId: 1 };

function spec<T = unknown>(over: Partial<TaskSpec<T>> = {}): TaskSpec<T> {
    return {
        feature: 'demo',
        origin: HERE,
        title: 'Opération',
        dialog: true,
        minimizable: true,
        local: false,
        failure: () => ({ message: 'Échec.', code: null }),
        ...over
    };
}

/** Une promesse soldée de l'extérieur, comme une commande qui répond plus tard. */
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Lance une opération et rend aussi le contexte que son travail a reçu. */
function launch<T>(over: Partial<TaskSpec<T>> = {}) {
    const work = deferred<T>();
    let context!: TaskContext;
    const done = startTask(spec<T>(over), (task) => {
        context = task;
        return work.promise;
    });
    const id = getTaskRecords()[getTaskRecords().length - 1].id;
    return { done, work, context, id };
}

const coded = (code: string): Error => Object.assign(new Error(code), { code });

/** Le temps qu'un avancement retenu soit publié. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, PROGRESS_GAP_MS + 30));

beforeEach(() => resetTasks());

describe('startTask', () => {
    it('rend le résultat et le rejet du travail tels quels', async () => {
        const ok = launch<number>();
        ok.work.resolve(42);
        assert.equal(await ok.done, 42);

        const failure = new Error('refus');
        const ko = launch();
        ko.work.reject(failure);
        await assert.rejects(ko.done, (e) => e === failure);
    });

    it('sort sans trace quand le dialogue n’a jamais été réduit', async () => {
        const ok = launch();
        ok.work.resolve(null);
        await ok.done;
        assert.equal(getTaskRecords().length, 0);

        const ko = launch();
        ko.work.reject(new Error('refus'));
        await assert.rejects(ko.done);
        assert.equal(getTaskRecords().length, 0);
    });

    it('garde le succès d’une opération réduite jusqu’à ce que le panneau l’ait montré', async () => {
        const task = launch<number>({ done: (n) => `${n} fichiers traités.` });
        minimizeTask(task.id);
        task.work.resolve(3);
        await task.done;
        const [record] = getTaskRecords();
        assert.equal(record.state, 'done');
        assert.equal(record.note, '3 fichiers traités.');
        assert.equal(record.seen, false);

        setPanelOpen(true);
        assert.equal(getTaskRecords()[0].seen, true);
        setPanelOpen(false);
        assert.equal(getTaskRecords().length, 0);
    });

    it('écrit « Terminé. » sans phrase de succès, et la chaîne quand elle est donnée', async () => {
        const plain = launch();
        minimizeTask(plain.id);
        plain.work.resolve(null);
        await plain.done;
        assert.equal(getTaskRecords()[0].note, 'Terminé.');
        clearFinished();

        const named = launch({ done: 'Point supprimé.' });
        minimizeTask(named.id);
        named.work.resolve(null);
        await named.done;
        assert.equal(getTaskRecords()[0].note, 'Point supprimé.');
    });

    it('garde l’échec d’une opération réduite jusqu’à sa croix', async () => {
        const task = launch({ failure: () => ({ message: 'Suppression impossible.', code: 'internal' }) });
        minimizeTask(task.id);
        task.work.reject(new Error('panne'));
        await assert.rejects(task.done);
        assert.deepEqual(getTaskRecords()[0].error, { message: 'Suppression impossible.', code: 'internal' });

        setPanelOpen(true);
        setPanelOpen(false);
        assert.equal(getTaskRecords().length, 1);
        dismissTask(task.id);
        assert.equal(getTaskRecords().length, 0);
    });

    it('part directement dans la zone sans dialogue', () => {
        const task = launch({ dialog: false });
        assert.equal(foregroundOf(getTaskRecords()), null);
        assert.equal(zoneOf(getTaskRecords())[0].id, task.id);
    });

    it('ne réduit pas un dialogue bloquant', () => {
        const task = launch({ minimizable: false });
        minimizeTask(task.id);
        assert.equal(foregroundOf(getTaskRecords())?.id, task.id);
        assert.equal(zoneOf(getTaskRecords()).length, 0);
    });

    it('prévient l’appelant une seule fois, à la première réduction', () => {
        let detached = 0;
        const task = launch({ onDetach: () => (detached += 1) });
        minimizeTask(task.id);
        raiseTask(task.id);
        minimizeTask(task.id);
        assert.equal(detached, 1);
    });

    it('lit l’avancement de la commande et celui d’un travail local', async () => {
        const task = launch();
        task.context.sendOptions.onProgress?.({ step: 'Libération de l’espace', done: 3, total: 12 });
        assert.equal(getTaskRecords()[0].value, 0.25);
        assert.equal(getTaskRecords()[0].step, 'Libération de l’espace : 3 sur 12');

        await settle();
        task.context.sendOptions.onProgress?.({ step: 'En attente' });
        assert.equal(getTaskRecords()[0].value, undefined);

        await settle();
        task.context.report({ value: 0.5, step: 'Transfert…' });
        assert.equal(getTaskRecords()[0].value, 0.5);
        await settle();
        task.context.report({ value: null });
        assert.equal(getTaskRecords()[0].value, undefined);
        assert.equal(getTaskRecords()[0].step, 'Transfert…');
    });

    it('ne publie pas chaque avancement d’un travail qui en rapporte des centaines', async () => {
        const task = launch({ local: true });
        let published = 0;
        const off = onTasksChange(() => (published += 1));
        for (let page = 1; page <= 300; page += 1) task.context.report({ value: page / 300, step: `Page ${page}` });
        assert.equal(published, 1, 'le premier part tout de suite, les suivants attendent');
        assert.equal(getTaskRecords()[0].step, 'Page 1');

        await settle();
        off();
        assert.equal(published, 2);
        assert.equal(getTaskRecords()[0].step, 'Page 300', 'le dernier est toujours publié');
        assert.equal(getTaskRecords()[0].value, 1);
    });

    it('oublie l’avancement retenu d’une opération finie ou annulée', async () => {
        const done = launch();
        minimizeTask(done.id);
        done.context.report({ step: 'un' });
        done.context.report({ step: 'deux' });
        done.work.resolve(null);
        await done.done;
        await settle();
        assert.equal(getTaskRecords()[0].state, 'done');
        assert.equal(getTaskRecords()[0].step, 'un');
        clearFinished();

        const work = deferred<void>();
        const cancelled = startTask(spec({ cancel: () => undefined }), (task) => {
            task.report({ step: 'un' });
            task.report({ step: 'deux' });
            return work.promise;
        });
        const { id } = getTaskRecords()[0];
        minimizeTask(id);
        cancelTask(id);
        await settle();
        assert.equal(getTaskRecords()[0].step, 'Annulation…');
        work.reject(new Error('abandon'));
        await assert.rejects(cancelled);
    });

    it('vise l’espace d’origine et tolère un long silence', () => {
        const task = launch({ origin: { instanceId: null, workspaceId: 7 } });
        assert.equal(task.context.sendOptions.workspaceId, 7);
        assert.equal(task.context.sendOptions.timeoutMs, 120_000);
    });

    it('dit « perdue » quand la socket d’une commande tombe', async () => {
        const task = launch();
        minimizeTask(task.id);
        task.work.reject(coded('closed'));
        await assert.rejects(
            task.done,
            (e) => e instanceof TaskError && e.code === 'closed' && e.message === LOST_NOTE
        );
        assert.equal(getTaskRecords()[0].state, 'lost');
    });

    it('tient la coupure d’un travail local pour un échec', async () => {
        const failure = coded('closed');
        const task = launch({ local: true });
        minimizeTask(task.id);
        task.work.reject(failure);
        await assert.rejects(task.done, (e) => e === failure);
        assert.equal(getTaskRecords()[0].state, 'failed');
    });

    it('explique le silence d’une commande', async () => {
        const task = launch();
        minimizeTask(task.id);
        task.work.reject(coded('timeout'));
        await assert.rejects(task.done, (e) => e instanceof TaskError && e.code === 'timeout');
        assert.deepEqual(getTaskRecords()[0].error, { message: SILENT_NOTE, code: 'timeout' });
    });

    it('refuse une seconde opération de même clé sur le même élément', async () => {
        const first = launch({ key: 'delete', itemId: '4' });
        let called = false;
        const second = startTask(spec({ key: 'delete', itemId: '4' }), () => {
            called = true;
            return Promise.resolve();
        });
        await assert.rejects(second, (e) => e instanceof TaskError && e.code === 'conflict');
        assert.equal(called, false);

        // Un autre élément, une autre origine, ou la même après la fin : permis.
        await startTask(spec({ key: 'delete', itemId: '5' }), () => Promise.resolve());
        await startTask(spec({ key: 'delete', itemId: '4', origin: { instanceId: null, workspaceId: 2 } }), () =>
            Promise.resolve()
        );
        first.work.resolve(null);
        await first.done;
        await startTask(spec({ key: 'delete', itemId: '4' }), () => Promise.resolve());
    });

    it('fait sortir une opération abandonnée, sans résultat', async () => {
        const work = deferred<void>();
        const done = startTask(
            spec({ local: true, cancel: () => work.reject(new Error('abandon')) }),
            () => work.promise
        );
        const { id } = getTaskRecords()[0];
        minimizeTask(id);
        cancelTask(id);
        await assert.rejects(done, (e) => e instanceof TaskError && e.code === 'cancelled');
        assert.equal(getTaskRecords().length, 0);
    });

    it('garde le succès d’un abandon arrivé trop tard', async () => {
        const work = deferred<string>();
        const done = startTask(spec<string>({ cancel: () => undefined }), () => work.promise);
        const { id } = getTaskRecords()[0];
        minimizeTask(id);
        cancelTask(id);
        work.resolve('fait');
        assert.equal(await done, 'fait');
        assert.equal(getTaskRecords()[0].state, 'done');
    });

    it('ne ressuscite rien après une fin de session', async () => {
        const task = launch();
        minimizeTask(task.id);
        resetTasks();
        task.work.resolve(null);
        await task.done;
        assert.equal(getTaskRecords().length, 0);
    });

    it('arrête le travail local à la fin de session', () => {
        let stopped = false;
        launch({ local: true, cancel: () => (stopped = true) });
        resetTasks();
        assert.equal(stopped, true);
    });

    it('plafonne les opérations finies', async () => {
        for (let i = 0; i < 32; i += 1) {
            const task = launch({ dialog: false });
            task.work.resolve(null);
            await task.done;
        }
        assert.equal(getTaskRecords().length, 30);
    });
});

describe('lectures', () => {
    it('montre le dialogue de la dernière opération ramenée devant', () => {
        const first = launch();
        const second = launch();
        assert.equal(foregroundOf(getTaskRecords())?.id, second.id);
        raiseTask(first.id);
        assert.equal(foregroundOf(getTaskRecords())?.id, first.id);
        minimizeTask(first.id);
        assert.equal(foregroundOf(getTaskRecords())?.id, second.id);
    });

    it('ne rend que les opérations en cours de l’espace demandé', async () => {
        const here = launch({ itemId: '4', key: 'verify' });
        launch({ itemId: '9' });
        launch({ origin: { instanceId: null, workspaceId: 2 }, itemId: '4' });
        launch({ origin: { instanceId: 3, workspaceId: 1 }, itemId: '4' });

        assert.equal(matchRunning(getTaskRecords(), { feature: 'demo' }, HERE).length, 2);
        assert.equal(matchRunning(getTaskRecords(), { feature: 'demo', itemId: 4 }, HERE).length, 1);
        assert.equal(matchRunning(getTaskRecords(), { feature: 'demo', key: 'verify' }, HERE)[0].id, here.id);
        assert.equal(matchRunning(getTaskRecords(), { feature: 'autre' }, HERE).length, 0);

        minimizeTask(here.id);
        here.work.resolve(null);
        await here.done;
        assert.equal(matchRunning(getTaskRecords(), { feature: 'demo', itemId: 4 }, HERE).length, 0);
    });

    it('donne à la puce son état', async () => {
        assert.equal(chipOf(getTaskRecords()), null);

        const front = launch();
        assert.equal(chipOf(getTaskRecords()), null, 'une opération au premier plan ne compte pas');

        minimizeTask(front.id);
        front.context.report({ value: 0.4 });
        assert.deepEqual(chipOf(getTaskRecords()), { tone: 'running', count: 1, value: 0.4, alert: null });

        const other = launch({ dialog: false });
        assert.deepEqual(chipOf(getTaskRecords()), { tone: 'running', count: 2, value: undefined, alert: null });

        other.work.reject(new Error('panne'));
        await assert.rejects(other.done);
        assert.equal(chipOf(getTaskRecords())?.alert, 'failed');

        front.work.resolve(null);
        await front.done;
        assert.deepEqual(
            chipOf(getTaskRecords()),
            { tone: 'failed', count: 1, alert: null },
            'le compte est celui des échecs, pas des résultats'
        );

        dismissTask(other.id);
        assert.deepEqual(chipOf(getTaskRecords()), { tone: 'done', count: 1, alert: null });
    });

    it('signale une perte quand rien n’a échoué', async () => {
        const task = launch({ dialog: false });
        task.work.reject(coded('closed'));
        await assert.rejects(task.done);
        assert.equal(chipOf(getTaskRecords())?.tone, 'lost');
    });

    it('sait qu’un travail tourne dans l’onglet', async () => {
        assert.equal(hasLocalWork(), false);
        launch();
        assert.equal(hasLocalWork(), false);
        const local = launch({ local: true });
        assert.equal(hasLocalWork(), true);
        local.work.resolve(null);
        await local.done;
        assert.equal(hasLocalWork(), false);
    });

    it('écrit l’étape et le compte en une phrase', () => {
        assert.equal(stepOf('Copie', 2, 5), 'Copie : 2 sur 5');
        assert.equal(stepOf('Copie', undefined, undefined), 'Copie');
        assert.equal(stepOf(undefined, 2, 5), '2 sur 5');
        assert.equal(stepOf(undefined, undefined, 0), undefined);
    });
});
