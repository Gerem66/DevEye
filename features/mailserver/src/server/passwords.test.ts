import assert from 'node:assert/strict';
import test from 'node:test';

import { generateSecret, hashSecret, verifySecret } from './passwords';

test('un secret se vérifie contre son hachage, et contre lui seul', async () => {
    const hash = await hashSecret('correct horse');
    assert.match(hash, /^scrypt\$[\w-]+\$[\w-]+$/);
    assert.equal(await verifySecret('correct horse', hash), true);
    assert.equal(await verifySecret('correct horsf', hash), false);
    assert.notEqual(hash, await hashSecret('correct horse'), 'le sel change');
});

test('un hachage illisible refuse sans lever', async () => {
    assert.equal(await verifySecret('x', ''), false);
    assert.equal(await verifySecret('x', 'bcrypt$a$b'), false);
});

test('un secret généré a la longueur demandée et reste dans son alphabet', () => {
    const secret = generateSecret();
    assert.equal(secret.length, 24);
    assert.match(secret, /^[a-km-zA-HJ-NP-Z2-9]+$/);
    assert.notEqual(secret, generateSecret());
});
