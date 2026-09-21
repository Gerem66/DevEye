import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const POLICY = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../policy/policy.xml');

/**
 * Le lecteur XML d'ImageMagick prend une apostrophe ou un guillemet de
 * commentaire pour un début de chaîne, et avale sans rien dire les règles qui
 * suivent : la politique a l'air en place et ne borne plus rien.
 */
describe('politique ImageMagick', () => {
    const xml = readFileSync(POLICY, 'utf8');

    it('ne porte ni apostrophe ni guillemet dans ses commentaires', () => {
        for (const [comment] of xml.matchAll(/<!--[\s\S]*?-->/g)) {
            assert.doesNotMatch(comment, /['"’`]/, comment.slice(0, 60));
        }
    });

    it('borne les ressources, coupe les délégués, et ne lit jamais un PDF', () => {
        for (const name of ['width', 'height', 'area', 'memory', 'disk']) {
            assert.match(xml, new RegExp(`domain="resource" name="${name}" value="[^"]+"`));
        }
        assert.match(xml, /domain="delegate" rights="none" pattern="\*"/);
        assert.match(xml, /domain="coder" rights="write" pattern="PDF"/);
    });
});
