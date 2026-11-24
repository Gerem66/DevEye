import assert from 'node:assert/strict';
import { afterEach, beforeEach } from 'node:test';
import {
    clientMessageSchema,
    featureCommandRegistry,
    registerFeatureCommands,
    type ClientMessage,
    type CommandInput,
    type CommandOutput,
    type ErrorCode,
    type FeatureCommandName,
    type ServerMessage,
    type WorkspaceKind
} from '@deveye/types';
import type { FeatureManifest } from '@deveye/types/sdk';
import type { z, ZodType } from 'zod';

import { ws } from '@/api/ws';
import { resetWorkspace, syncWorkspacesFromServer } from '@/stores/workspace';

/**
 * Le serveur des tests de composants. Il ne remplace que la socket du
 * navigateur : tout ce qui est au-dessus tourne pour de vrai (`ws.send`, les
 * magasins, les invites), et aucun module n'est simulé. Une réponse passe par
 * le schéma de sortie de sa commande, donc un test ne peut pas faire dire au
 * serveur ce que le vrai ne dirait pas.
 */

/** Le refus d'une commande, tel que le serveur le rend : à lever depuis une réponse. */
export class Refusal extends Error {
    constructor(
        public readonly code: ErrorCode,
        message: string = code,
        public readonly details?: unknown
    ) {
        super(message);
    }
}

type Answer<Input, Output> = (input: Input, envelope: ClientMessage) => Output | Promise<Output>;

type CommandOf<M extends FeatureManifest, N extends string> = Extract<M['commands'][number], { command: N }>;

/** Les commandes d'un module, typées par son manifest. */
export interface FakeFeature<M extends FeatureManifest> {
    on<N extends M['commands'][number]['command']>(
        command: N,
        answer: Answer<z.output<CommandOf<M, N>['input'] & ZodType>, z.input<CommandOf<M, N>['output'] & ZodType>>
    ): void;
    calls<N extends M['commands'][number]['command']>(command: N): z.output<CommandOf<M, N>['input'] & ZodType>[];
}

export interface FakeServer {
    /** Ce que le serveur répond à une commande, jusqu'à la fin du test. Lever un {@link Refusal} la refuse. */
    on<N extends FeatureCommandName>(command: N, answer: Answer<CommandInput<N>, CommandOutput<N>>): void;
    /** Les entrées reçues pour une commande, dans l'ordre. */
    calls<N extends FeatureCommandName>(command: N): CommandInput<N>[];
    /** Les mêmes, pour un module : ses contrats entrent au registre comme à son installation. */
    feature<const M extends FeatureManifest>(manifest: M): FakeFeature<M>;
    /** Ouvre la socket du client, session acceptée. Après les `on` dont l'ouverture a besoin. */
    connect(): Promise<void>;
    /** Un événement que personne n'a demandé. */
    push(command: string, data: unknown): void;
    /**
     * Assoit le test dans un espace dont l'appelant est propriétaire, comme la
     * session le livre à la connexion. Sans cet appel, aucun espace n'est actif.
     */
    workspace(kind: WorkspaceKind): void;
}

type Listener = (event: { data?: string; code?: number }) => void;

/**
 * Ce que le client demande de lui-même à chaque ouverture, avec la réponse
 * d'un compte sans chiffrement par mot de passe. Un test qui en a une autre à
 * donner la déclare avant `connect()`.
 */
const AT_OPENING: readonly (readonly [string, Answer<never, unknown>])[] = [
    [
        'secrecy.status',
        () => ({
            status: {
                enabled: false,
                unlocked: false,
                recoveryEnabled: false,
                reAuthInterval: null,
                unlockedUntil: null
            }
        })
    ]
];

let answers = new Map<string, Answer<never, unknown>>();
let received: ClientMessage[] = [];
/** Ce qu'un test n'a pas prévu : chaque ligne le fait échouer à sa fin. */
let problems: string[] = [];

class FakeSocket {
    /** La socket que le client tient ouverte. */
    static open: FakeSocket | null = null;

    readonly bufferedAmount = 0;
    private readonly listeners = new Map<string, Listener[]>();
    private closed = false;

    constructor(readonly url: string) {
        FakeSocket.open = this;
        this.deliver({ command: 'session', payload: { ok: true, data: { userId: 1 } } });
    }

    addEventListener(type: string, listener: Listener): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    /** Comme le réseau : jamais dans le tour d'exécution de qui a écrit. */
    deliver(message: ServerMessage): void {
        setTimeout(() => {
            if (this.closed) return;
            for (const listener of this.listeners.get('message') ?? []) listener({ data: JSON.stringify(message) });
        }, 0);
    }

    send(raw: string): void {
        const frame = clientMessageSchema.safeParse(JSON.parse(raw));
        if (!frame.success) {
            problems.push(`trame que le serveur refuserait : ${raw.slice(0, 200)}`);
            return;
        }
        received.push(frame.data);
        // Une trame postée (`ws.post`) n'attend pas de réponse.
        if (frame.data.requestId !== '-') void this.answer(frame.data);
    }

    private async answer(frame: ClientMessage): Promise<void> {
        const { requestId, command } = frame;
        const refuse = (code: ErrorCode, message: string, details?: unknown): void =>
            this.deliver({ requestId, command, payload: { ok: false, error: { code, message, details } } });

        const answer = answers.get(command);
        const descriptor = featureCommandRegistry[command];
        if (!answer || !descriptor) {
            problems.push(`« ${command} » est partie sans que le test ait dit quoi répondre`);
            refuse('internal', `fakeServer : aucune réponse pour ${command}`);
            return;
        }
        try {
            const output = descriptor.output.safeParse(await answer(frame.payload as never, frame));
            if (output.success) {
                this.deliver({ requestId, command, payload: { ok: true, data: output.data } });
                return;
            }
            problems.push(`la réponse à « ${command} » ne suit pas son schéma : ${output.error.message}`);
            refuse('internal', `fakeServer : réponse invalide pour ${command}`);
        } catch (error) {
            if (error instanceof Refusal) refuse(error.code, error.message, error.details);
            else throw error;
        }
    }

    close(code = 1000): void {
        if (this.closed) return;
        this.closed = true;
        for (const listener of this.listeners.get('close') ?? []) listener({ code });
    }
}

/**
 * À appeler en tête d'un fichier de test. Chaque test repart d'une socket
 * fermée et d'un serveur qui ne sait répondre qu'à l'ouverture, et échoue si une
 * commande est partie sans réponse ou si une réponse ne suivait pas son schéma.
 */
export function fakeServer(): FakeServer {
    beforeEach(() => {
        answers = new Map(AT_OPENING);
        received = [];
        problems = [];
        resetWorkspace();
        globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    });

    afterEach(() => {
        ws.close();
        FakeSocket.open = null;
        assert.deepEqual(problems, [], 'le serveur des tests a relevé des imprévus');
    });

    const on = (command: string, answer: unknown): void => void answers.set(command, answer as Answer<never, unknown>);
    const calls = (command: string): never[] =>
        received.filter((frame) => frame.command === command).map((frame) => frame.payload as never);

    return {
        on,
        calls,
        feature: (manifest) => {
            registerFeatureCommands(manifest.commands);
            return { on, calls };
        },
        connect: () => ws.connect(),
        push: (command, data) => {
            assert.ok(FakeSocket.open, 'push : la socket n’est pas ouverte');
            FakeSocket.open.deliver({ command, payload: { ok: true, data } });
        },
        workspace: (kind) =>
            syncWorkspacesFromServer(
                [
                    {
                        id: 1,
                        kind,
                        name: 'Essai',
                        logo: '',
                        ownerUserId: 1,
                        users: [],
                        features: [],
                        created: 0,
                        planPaused: false,
                        pausedMemberIds: []
                    }
                ],
                1,
                { isOwner: true, capabilities: [], features: [], itemOverrides: [] }
            )
    };
}
