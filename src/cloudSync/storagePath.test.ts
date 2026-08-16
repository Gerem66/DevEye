import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mountPointFor } from './pathValidation';

/**
 * La détection de chemin éphémère a déjà refusé une configuration VALIDE, faute
 * d'avoir distingué le chemin de l'hôte de celui du conteneur. Ces cas figent
 * la règle : un sous-dossier est porté par le montage du dessus, et seul ce qui
 * retombe sur `/` vit sur la couche d'écriture du conteneur.
 */

/** Une liste de points de montage typique d'un conteneur applicatif. */
const CONTAINER = [
    '/',
    '/proc',
    '/dev',
    '/sys',
    '/etc/hosts',
    '/etc/resolv.conf',
    '/data/cloudsync',
    '/app/agent/dist'
];

describe('mountPointFor', () => {
    it('rattache un sous-dossier au volume qui le porte', () => {
        // LE cas qui refusait à tort : le partage vit SOUS le point de montage,
        // il n'en est pas un lui-même.
        assert.equal(mountPointFor('/data/cloudsync/documents', CONTAINER), '/data/cloudsync');
        assert.equal(mountPointFor('/data/cloudsync/a/b/c', CONTAINER), '/data/cloudsync');
        assert.equal(mountPointFor('/data/cloudsync', CONTAINER), '/data/cloudsync');
    });

    it('retombe sur la racine pour un chemin hors volume', () => {
        // Le chemin de l'HÔTE saisi par erreur comme chemin conteneur : rien ne
        // le monte, donc il est bien éphémère.
        assert.equal(mountPointFor('/srv/DevEye-CloudSync/documents', CONTAINER), '/');
        assert.equal(mountPointFor('/tmp/essai', CONTAINER), '/');
    });

    it('ne confond pas un préfixe de NOM avec un préfixe de CHEMIN', () => {
        // `/data/cloudsync-old` n'est pas dans `/data/cloudsync`, malgré le
        // préfixe textuel commun.
        assert.equal(mountPointFor('/data/cloudsync-old/x', CONTAINER), '/');
    });

    it('retient le montage le plus profond', () => {
        const nested = ['/', '/data', '/data/cloudsync'];
        assert.equal(mountPointFor('/data/cloudsync/x', nested), '/data/cloudsync');
        assert.equal(mountPointFor('/data/autre/x', nested), '/data');
    });
});
