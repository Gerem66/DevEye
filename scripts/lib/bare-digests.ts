import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { scopeRoots } from './scope-files';

/**
 * La garde des condensés sans clé. Le SHA-256 nu d'une valeur que la base garde
 * chiffrée se recalcule par quiconque la devine : il la confirme, et relie les
 * espaces qui la partagent. Une telle valeur se condense par `keys.ref`. Tout
 * appel restant à une fonction de hachage sans clé se déclare, avec ce qu'il
 * condense et pourquoi une clé n'y changerait rien : dans le
 * `deveye-digests.json` de son module, et dans `src/digests.json` pour le socle
 * et pour `@deveye/types`.
 */

/** Les façons d'obtenir un condensé sans clé : Node (`createHash`, `crypto.hash`) et WebCrypto. */
const BARE_DIGEST = /\bcreateHash\(|\bcrypto\.hash\(|\bsubtle\.digest\(/g;

const SOURCE = /\.(?:ts|tsx|mts|mjs|js)$/;
const TEST = /\.test\.(?:ts|tsx)$/;

export const digestFileSchema = z.strictObject({
    allow: z.record(
        z.string(),
        z.strictObject({
            /** Le nombre d'appels du fichier : un appel de plus ne passe pas sous la raison des autres. */
            count: z.number().int().positive(),
            reason: z.string().trim().min(20)
        })
    )
});

/** Un dépôt de code et sa déclaration : le socle, ou un module installé. */
export interface DigestRoot {
    /** Le dossier, depuis celui du workspace : ce que le rapport affiche. */
    label: string;
    dir: string;
    /** Les dossiers lus, depuis `dir`. */
    scan: readonly string[];
    /** Sa déclaration, qu'elle existe ou non. */
    file: string;
}

/** Le socle (serveur, client, et la copie de `@deveye/types` qu'il exécute) et chaque module installé. */
export function digestRoots(root: string, workspace: string): DigestRoot[] {
    return scopeRoots(root, workspace).map(({ label, dir }) =>
        dir === root
            ? {
                  label,
                  dir,
                  scan: ['src', path.join('client', 'src'), path.join('node_modules', '@deveye', 'types', 'src')],
                  file: path.join(dir, 'src', 'digests.json')
              }
            : { label, dir, scan: ['src'], file: path.join(dir, 'deveye-digests.json') }
    );
}

function walk(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (SOURCE.test(entry.name) && !TEST.test(entry.name)) out.push(full);
    }
    return out;
}

/** Les fichiers d'un dépôt qui condensent sans clé, avec leur nombre d'appels. Les tests n'en sont pas. */
export function bareDigestsOf(root: DigestRoot): Map<string, number> {
    const found = new Map<string, number>();
    for (const sub of root.scan) {
        for (const file of walk(path.join(root.dir, sub))) {
            const count = fs.readFileSync(file, 'utf8').match(BARE_DIGEST)?.length ?? 0;
            if (count > 0) found.set(path.relative(root.dir, file).split(path.sep).join('/'), count);
        }
    }
    return found;
}

/** Ce qui cloche : un appel non déclaré, un compte qui ne suit plus, une déclaration sans objet ou mal écrite. */
export function bareDigestProblems(roots: readonly DigestRoot[]): string[] {
    const problems: string[] = [];
    for (const root of roots) {
        const found = bareDigestsOf(root);
        const where = path.join(root.label, path.relative(root.dir, root.file));
        let allow: z.infer<typeof digestFileSchema>['allow'] = {};
        if (fs.existsSync(root.file)) {
            let raw: unknown;
            try {
                raw = JSON.parse(fs.readFileSync(root.file, 'utf8'));
            } catch (e) {
                problems.push(`${where} : JSON illisible (${(e as Error).message})`);
                continue;
            }
            const parsed = digestFileSchema.safeParse(raw);
            if (!parsed.success) {
                for (const issue of parsed.error.issues)
                    problems.push(`${where} : ${issue.path.join('.')} ${issue.message}`);
                continue;
            }
            allow = parsed.data.allow;
        }
        for (const [file, count] of found) {
            const declared = allow[file];
            const at = path.join(root.label, file);
            if (!declared) {
                problems.push(
                    `${at} condense sans clé (${count} appel${count > 1 ? 's' : ''}) : passez par keys.ref, ou déclarez-le avec sa raison dans ${where}.`
                );
            } else if (declared.count !== count) {
                problems.push(
                    `${at} : ${count} appel${count > 1 ? 's' : ''} pour ${declared.count} déclaré${declared.count > 1 ? 's' : ''} dans ${where}. La raison écrite couvre-t-elle le nouveau ?`
                );
            }
        }
        for (const file of Object.keys(allow)) {
            if (!found.has(file)) problems.push(`${where} : « ${file} » ne condense plus rien, retirez sa ligne.`);
        }
    }
    return problems;
}
