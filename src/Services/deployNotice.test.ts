import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DeploymentRow } from 'deveye-types';

import { buildNotice, estimateFromHistory, progressBar, tailOf } from './DeployNotice';

type DiscordNotice = ReturnType<typeof buildNotice>;

/**
 * Le message de suivi d'un déploiement.
 *
 * Ce qui est vérifié ici, ce n'est pas la mise en page — elle se juge à l'œil
 * dans Discord — mais les trois calculs qui peuvent **mentir en silence** :
 * l'estimation, le bornage de la barre, et le nettoyage du journal. Une erreur
 * dans l'un des trois ne casse rien : elle produit un message plausible et faux,
 * ce qui est précisément le mode de panne qu'on ne remarquerait jamais.
 *
 * Le reste (couleurs, ordre des champs) est du câblage visible à la lecture, et
 * le tester reviendrait à recopier la fonction dans son propre test.
 */

function row(over: Partial<DeploymentRow> & { id: number }): DeploymentRow {
    return {
        target_id: 1,
        workspace_id: 1,
        external_id: null,
        status: 'success',
        triggered_by_user_id: null,
        started_at: 0,
        finished_at: null,
        notified: 1,
        content: '',
        ...over
    };
}

describe('estimateFromHistory — la durée de référence', () => {
    it('moyenne les déploiements réussis', () => {
        const history = [
            row({ id: 1, started_at: 100, finished_at: 160 }), // 60 s
            row({ id: 2, started_at: 200, finished_at: 320 }) // 120 s
        ];
        assert.equal(estimateFromHistory(history, 99), 90);
    });

    it('écarte les échecs', () => {
        // Le point de tout le calcul : un échec s'arrête à la première étape qui
        // casse, souvent en quelques secondes. L'inclure ferait chuter
        // l'estimation à chaque build raté, et la barre d'un déploiement sain
        // sauterait à 100 % au bout de dix secondes.
        const history = [
            row({ id: 1, started_at: 100, finished_at: 160 }),
            row({ id: 2, status: 'failed', started_at: 200, finished_at: 203 })
        ];
        assert.equal(estimateFromHistory(history, 99), 60);
    });

    it('s’exclut lui-même', () => {
        // Le déploiement en cours est dans l'historique lu : se compter
        // reviendrait à estimer sa durée à partir de sa propre durée.
        const history = [row({ id: 7, started_at: 100, finished_at: 160 })];
        assert.equal(estimateFromHistory(history, 7), null);
    });

    it('rend null sans mesure exploitable', () => {
        // Une cible neuve : pas de barre du tout, plutôt qu'une barre calée sur
        // une valeur inventée.
        assert.equal(estimateFromHistory([], 1), null);
        assert.equal(estimateFromHistory([row({ id: 1, started_at: 100, finished_at: 100 })], 9), null);
    });

    it('ne retient que les dix derniers', () => {
        // Douze déploiements d'une seconde, puis un très long : s'il entrait
        // dans la moyenne, une cible qui a accéléré resterait jugée sur son passé.
        const history = [
            ...Array.from({ length: 12 }, (_, i) => row({ id: i + 1, started_at: 0, finished_at: 10 })),
            row({ id: 99, started_at: 0, finished_at: 10_000 })
        ];
        assert.equal(estimateFromHistory(history, 0), 10);
    });
});

describe('progressBar — bornée à [0, 100] %', () => {
    it('remplit proportionnellement', () => {
        assert.equal(progressBar(0), '▱▱▱▱▱▱▱▱▱▱');
        assert.equal(progressBar(0.5), '▰▰▰▰▰▱▱▱▱▱');
        assert.equal(progressBar(1), '▰▰▰▰▰▰▰▰▰▰');
    });

    it('ne déborde jamais', () => {
        // Un déploiement plus long que la moyenne dépasse le ratio de 1. Sans
        // bornage, `repeat()` d'un négatif lèverait — au milieu d'une boucle de
        // fond, sur un message qu'on ne pourrait plus conclure.
        assert.equal(progressBar(3).length, 10);
        assert.equal(progressBar(-1), '▱▱▱▱▱▱▱▱▱▱');
        assert.equal(progressBar(Number.NaN).length, 10);
    });
});

describe('tailOf — la queue du journal', () => {
    it('retire les séquences ANSI', () => {
        // Dokploy colore sa sortie ; un bloc de code Discord les rendrait telles
        // quelles et le journal arriverait noyé sous des `[0m`.
        assert.equal(tailOf('\u001b[32mok\u001b[0m'), 'ok');
    });

    it('garde les dernières lignes, pas les premières', () => {
        assert.equal(tailOf('a\nb\nc\nd', 2), 'c\nd');
    });

    it('ignore les lignes vides de fin', () => {
        // Sans cela le bloc s'ouvrirait sur du vide à chaque rafraîchissement,
        // la sortie d'un build se terminant presque toujours par un saut.
        assert.equal(tailOf('fin\n\n\n', 2), 'fin');
    });

    it('rend une chaîne vide quand il n’y a rien', () => {
        assert.equal(tailOf(''), '');
    });
});

describe('buildNotice — ce que le lecteur voit', () => {
    const base = {
        project: 'DevEye',
        service: 'server',
        environment: 'production',
        kind: 'compose',
        url: null,
        title: 'Manual deployment',
        startedAt: 1_000,
        error: '',
        log: '',
        estimateSeconds: 100,
        now: 1_050
    } as const;

    it('annonce le dépassement plutôt qu’une fin imminente', () => {
        // Le cœur du parti pris : passé la moyenne, la barre est pleine et le
        // texte le dit. Un « 100 % » nu sur un déploiement qui continue ferait
        // croire à une fin, et le lecteur se demanderait pourquoi le message ne
        // conclut pas.
        const notice = buildNotice({ ...base, status: 'running', finishedAt: null, now: 1_500 });
        const description = String((notice.embeds?.[0] as { description: string }).description);
        assert.match(description, /Plus long que d’habitude/);
        assert.match(description, /100 %/);
    });

    it('n’affiche aucune barre sans durée de référence', () => {
        const notice = buildNotice({
            ...base,
            status: 'running',
            finishedAt: null,
            estimateSeconds: null
        });
        const description = String((notice.embeds?.[0] as { description: string }).description);
        assert.match(description, /aucune durée de référence/);
        assert.doesNotMatch(description, /▰|▱/);
    });

    it('met l’erreur avant le journal sur un échec', () => {
        // C'est la ligne qui dit *pourquoi* : la faire suivre huit lignes de
        // build reviendrait à la cacher.
        const notice = buildNotice({
            ...base,
            status: 'failed',
            finishedAt: 1_100,
            error: 'exit code 1',
            log: 'ligne de build'
        });
        const description = String((notice.embeds?.[0] as { description: string }).description);
        assert.ok(description.indexOf('exit code 1') < description.indexOf('ligne de build'));
    });

    it('remplace « Écoulé » par « Durée » à la conclusion, à la même place', () => {
        // Le même message se transforme : l'œil ne doit pas avoir à rechercher
        // le temps ailleurs au moment où le déploiement se conclut.
        const encours = buildNotice({ ...base, status: 'running', finishedAt: null });
        const fini = buildNotice({ ...base, status: 'success', finishedAt: 1_100 });
        const nameAt = (n: DiscordNotice, i: number) => (n.embeds![0] as { fields: { name: string }[] }).fields[i].name;
        assert.equal(nameAt(encours, 5), '⏳ Écoulé');
        assert.equal(nameAt(fini, 5), '⏱️ Durée');
    });

    it('ajoute le lien Dokploy seulement quand il est reconstructible', () => {
        // Un lien faux enverrait le lecteur sur une page d'erreur au moment
        // précis où il cherche à comprendre un échec.
        const sans = buildNotice({ ...base, status: 'success', finishedAt: 1_100 });
        const avec = buildNotice({ ...base, status: 'success', finishedAt: 1_100, url: 'https://x/y' });
        const names = (n: DiscordNotice) => (n.embeds![0] as { fields: { name: string }[] }).fields.map((f) => f.name);
        assert.ok(!names(sans).includes('🔗 Dokploy'));
        assert.ok(names(avec).includes('🔗 Dokploy'));
    });

    it('ne montre pas de barre une fois conclu', () => {
        const notice = buildNotice({ ...base, status: 'success', finishedAt: 1_100 });
        const embed = notice.embeds?.[0] as { description: string; fields: { name: string }[] };
        assert.doesNotMatch(embed.description, /▰|▱/);
        assert.deepEqual(
            embed.fields.map((f) => f.name),
            ['🛠️ Projet', '⚙️ Service', '🌍 Environnement', '📦 Type', '📅 Démarré', '⏱️ Durée']
        );
    });
});
