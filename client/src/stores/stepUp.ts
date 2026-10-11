import { useSyncExternalStore } from 'react';

/**
 * L'invite du code d'application qu'un ordre à une machine réclame
 * (`stepup_required`). Une seule à la fois : les commandes qui la demandent
 * ensemble attendent la même saisie, puis repartent chacune (voir `api/ws.ts`).
 */
export interface StepUpPrompt {
    /** Le compte a une application d'authentification ; sans elle, l'invite explique comment l'ajouter. */
    twoFactor: boolean;
    /** Confirme le code sur la connexion qui l'a demandé (une instance distante a sa propre session). */
    confirm(code: string): Promise<void>;
}

/** Rejet d'{@link ensureStepUp} quand la personne ferme l'invite. */
export class StepUpCancelledError extends Error {
    constructor() {
        super('cancelled');
        this.name = 'StepUpCancelledError';
    }
}

type Waiter = { resolve: () => void; reject: (e: Error) => void };

let prompt: StepUpPrompt | null = null;
let waiters: Waiter[] = [];
const listeners = new Set<() => void>();

function emit(): void {
    for (const fn of listeners) fn();
}

/** Se résout une fois le code confirmé ; rejette si l'invite est fermée. */
export function ensureStepUp(request: StepUpPrompt): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        waiters.push({ resolve, reject });
        if (!prompt) {
            prompt = request;
            emit();
        }
    });
}

/** Le code est confirmé : chaque commande en attente repart. */
export function resolveStepUp(): void {
    const done = waiters;
    waiters = [];
    prompt = null;
    emit();
    for (const w of done) w.resolve();
}

export function cancelStepUp(): void {
    const done = waiters;
    waiters = [];
    prompt = null;
    emit();
    for (const w of done) w.reject(new StepUpCancelledError());
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function useStepUpPrompt(): StepUpPrompt | null {
    return useSyncExternalStore(subscribe, () => prompt);
}
