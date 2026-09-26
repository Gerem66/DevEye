import type { FeatureService, FeatureServiceDeps } from '@deveye/types/sdk/server';

import { financeDeclarationPeriodSchema, financeMicroActivitySchema } from '../contracts/domain';
import { declarationTarget, periodFigures, type MicroSettings } from './status';
import { DEFAULT_CURRENCY, invoicingLedger, partsOf, today, type LedgerIo } from './_shared';
import type { FinanceDeclaringRow, FinanceRepo } from './repo';
import { catchUp } from './sources';

/**
 * Le service de Finances : les rappels de déclaration URSSAF d'une
 * micro-entreprise, une semaine avant l'échéance puis la veille. Une lecture
 * ne sait pas quand minuit passe, d'où une boucle ; tout le reste du livre se
 * tient à la lecture. La table des rappels retient ce qui est parti : un rappel
 * ne part jamais deux fois, même à plusieurs instances.
 */

const REMIND_EVERY_MS = 6 * 60 * 60 * 1000;

/** Combien de jours séparent deux dates civiles. */
function daysUntil(from: string, to: string): number {
    const at = (value: string) => {
        const { year, month, day } = partsOf(value);
        return Date.UTC(year, month - 1, day);
    };
    return Math.round((at(to) - at(from)) / 86_400_000);
}

function money(cents: number, currency: string): string {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(cents / 100);
}

function longDate(value: string): string {
    const { year, month, day } = partsOf(value);
    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC'
    });
}

/** `clock` : la couture des tests, pour poser le jour sans attendre le calendrier. */
export function createService(deps: FeatureServiceDeps<FinanceRepo>, clock: () => string = today): FeatureService {
    async function remindOne(row: FinanceDeclaringRow, now: string) {
        const workspaceId = row.workspace_id;
        // Une valeur que le contrat ne connaît pas (écrite à la main en base) : pas de rappel plutôt qu'un faux.
        const activity = financeMicroActivitySchema.safeParse(row.micro_activity);
        const period = financeDeclarationPeriodSchema.safeParse(row.declaration_period);
        if (!activity.success || !period.success) return;
        const micro: MicroSettings = {
            activity: activity.data,
            period: period.data,
            socialOverrideBp: row.provision_rate_bp,
            incomeTaxPrepaid: row.income_tax_prepaid === 1
        };
        const target = declarationTarget(now, micro.period);
        if (!target.closed) return;
        const left = daysUntil(now, target.period.deadline);
        const stage = left <= 1 ? 'day' : left <= 7 ? 'week' : null;
        if (stage === null) return;

        const io: LedgerIo = {
            repo: deps.repo,
            workspaceId,
            providers: deps.providers,
            logger: deps.logger,
            cipher: () => deps.cipherFor(workspaceId)
        };
        // Les règlements de Facturation d'abord : le chiffre à déclarer les compte.
        await catchUp(io);
        const figures = await periodFigures(io, micro, target.period, now);
        if (!(await deps.repo.markReminder(workspaceId, target.period.key, stage))) return;

        const ledger = invoicingLedger(io);
        const currency = ledger === null ? DEFAULT_CURRENCY : (await ledger.profile(workspaceId)).currency;
        const which = micro.period === 'monthly' ? `de ${target.period.label}` : `du ${target.period.label}`;
        const when = left <= 0 ? 'dernier jour aujourd’hui' : left === 1 ? 'dernier jour demain' : `dans ${left} jours`;
        const tax = figures.incomeTax > 0 ? `, plus ${money(figures.incomeTax, currency)} d’impôt libératoire` : '';
        await deps.deveyeFor(workspaceId).notify.send({
            subject: `Déclaration URSSAF ${which} : ${when}`,
            body:
                `${money(figures.revenue, currency)} de chiffre d’affaires encaissé à déclarer au plus tard le ` +
                `${longDate(target.period.deadline)}. Cotisations estimées : ${money(figures.contributions, currency)}${tax}.`
        });
    }

    async function remind(): Promise<void> {
        const now = clock();
        for (const row of await deps.repo.listDeclaring()) {
            try {
                await remindOne(row, now);
            } catch (error) {
                // Un espace en panne ne prive pas les suivants de leur rappel.
                deps.logger.warn(
                    { err: error, workspaceId: row.workspace_id },
                    'finance: rappel de déclaration interrompu'
                );
            }
        }
    }

    const ticker = deps.createTicker({ intervalMs: REMIND_EVERY_MS, tick: remind });

    return {
        start() {
            ticker.start();
        },
        stop() {
            return ticker.stop();
        }
    };
}
