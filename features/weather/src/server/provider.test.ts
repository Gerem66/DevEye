import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { fetchWeatherReport, forgetProviderCaches, geocodeLocation, WeatherError } from './provider';
import type { FetchReportInput } from './provider';

/**
 * Aucun réseau : `fetch` est remplacé. Ce qui se vérifie tient à ce que le
 * quota du palier gratuit se compte par adresse IP, donc pour toute l'instance
 * à la fois : une seule requête par clé, l'échec gardé un temps, le plafond par
 * espace et le recul après un 429. Les caches et les seaux vivent dans le
 * processus, d'où les coordonnées distinctes d'un cas à l'autre.
 */

const realFetch = globalThis.fetch;

/** Les paramètres de `fetch` tels que la cible les déclare, sans nommer les types du DOM. */
type FetchArgs = Parameters<typeof globalThis.fetch>;

interface FetchStub {
    calls: number;
    signals: (AbortSignal | null | undefined)[];
}

function stubFetch(reply: (url: string) => Response | Promise<Response>): FetchStub {
    const stub: FetchStub = { calls: 0, signals: [] };
    globalThis.fetch = (async (input: FetchArgs[0], init?: FetchArgs[1]) => {
        stub.calls += 1;
        stub.signals.push(init?.signal);
        return reply(String(input));
    }) as typeof globalThis.fetch;
    return stub;
}

/** Tous les champs du relevé sont optionnels chez Open-Meteo : le minimum suffit. */
function forecastReply(): Response {
    return new Response(JSON.stringify({ timezone: 'Europe/Paris' }), { status: 200 });
}

function geocodeReply(): Response {
    const body = { results: [{ name: 'Paris', latitude: 48.8566, longitude: 2.3522, country: 'France' }] };
    return new Response(JSON.stringify(body), { status: 200 });
}

function input(over: Partial<FetchReportInput> = {}): FetchReportInput {
    return {
        workspaceId: 1,
        locationId: 'loc-1',
        label: 'Paris',
        latitude: 48.8566,
        longitude: 2.3522,
        format: 'current',
        days: 7,
        provider: 'open-meteo',
        ...over
    };
}

function isWeatherError(reason: WeatherError['reason']): (e: unknown) => boolean {
    return (e) => e instanceof WeatherError && e.reason === reason;
}

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe('Le provider météo', () => {
    it('ne lance qu’une requête pour deux lectures simultanées, puis sert le cache', async () => {
        let release = (): void => {};
        const gate = new Promise<void>((resolve) => (release = resolve));
        const stub = stubFetch(async () => {
            await gate;
            return forecastReply();
        });

        const first = fetchWeatherReport(input({ locationId: 'a', latitude: 1.0001 }));
        const second = fetchWeatherReport(input({ locationId: 'b', latitude: 1.0001 }));
        release();
        const [a, b] = await Promise.all([first, second]);

        assert.equal(stub.calls, 1);
        // Le relevé se partage, l'identité non : chacun lit sa propre ville.
        assert.equal(a.locationId, 'a');
        assert.equal(b.locationId, 'b');

        await fetchWeatherReport(input({ locationId: 'c', latitude: 1.0001 }));
        assert.equal(stub.calls, 1);
    });

    it('garde l’échec, et le rend à la clé changée', async () => {
        const stub = stubFetch(() => new Response('boom', { status: 500 }));

        await assert.rejects(fetchWeatherReport(input({ latitude: 2.0002 })), isWeatherError('fetch_failed'));
        await assert.rejects(fetchWeatherReport(input({ latitude: 2.0002 })), isWeatherError('fetch_failed'));
        assert.equal(stub.calls, 1);

        forgetProviderCaches('open-meteo');
        await assert.rejects(fetchWeatherReport(input({ latitude: 2.0002 })), isWeatherError('fetch_failed'));
        assert.equal(stub.calls, 2);
    });

    it('coupe la requête au bout d’un délai, et nomme la panne', async () => {
        const stub = stubFetch(() => {
            const timedOut = new Error('This operation was aborted');
            timedOut.name = 'TimeoutError';
            throw timedOut;
        });

        await assert.rejects(
            fetchWeatherReport(input({ latitude: 3.0003 })),
            (e) => e instanceof WeatherError && e.reason === 'fetch_failed' && e.message.includes('timed out')
        );
        assert.ok(stub.signals[0] instanceof AbortSignal);
    });

    it('plafonne les appels d’un espace, pour qu’il ne vide pas le quota des autres', async () => {
        const stub = stubFetch(() => geocodeReply());
        const workspaceId = 4242;

        // Le compte, plutôt que la capacité recopiée ici : elle se règle.
        let refused: unknown = null;
        let sent = 0;
        for (let i = 0; i < 1000 && refused === null; i++) {
            try {
                await geocodeLocation({ workspaceId, provider: 'open-meteo', query: `ville-${i}` });
                sent += 1;
            } catch (e) {
                refused = e;
            }
        }
        assert.ok(isWeatherError('rate_limited')(refused), 'le seau finit par refuser');
        assert.equal(stub.calls, sent);

        // Le seau est de l'espace : le voisin appelle toujours.
        await geocodeLocation({ workspaceId: workspaceId + 1, provider: 'open-meteo', query: 'ville-du-voisin' });
        assert.equal(stub.calls, sent + 1);
    });

    // En dernier : le recul est du fournisseur, donc commun à tout ce qui suit.
    it('arrête tout ce qui part vers un fournisseur qui a répondu 429', async () => {
        const stub = stubFetch(() => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }));

        await assert.rejects(
            fetchWeatherReport(input({ latitude: 5.0005 })),
            (e) => e instanceof WeatherError && e.reason === 'rate_limited' && e.retryAfterMs === 30_000
        );
        await assert.rejects(fetchWeatherReport(input({ latitude: 6.0006 })), isWeatherError('rate_limited'));
        assert.equal(stub.calls, 1);
    });
});
