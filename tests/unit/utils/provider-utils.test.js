import { describe, test, expect } from '@jest/globals';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
    normalizePath,
    getFileName,
    pathsEqual,
    detectProviderFromPath,
    getProviderMappingByDirName,
    createProviderConfig,
    addToUsedPaths,
    isPathLinked,
    formatSystemPath,
    generateUUID,
    isPathUsed,
    isValidOAuthCredentials,
} from '../../../src/utils/provider-utils.js';

describe('provider-utils', () => {
    test('normalizePath uses forward slashes', () => {
        expect(normalizePath('a\\b\\c')).toBe('a/b/c');
    });

    test('getFileName', () => {
        expect(getFileName('/x/y/z.json')).toBe('z.json');
    });

    test('pathsEqual basic', () => {
        expect(pathsEqual('./foo/bar', 'foo/bar')).toBe(true);
        expect(pathsEqual('a', 'b')).toBe(false);
    });

    test('detectProviderFromPath finds gemini', () => {
        const m = detectProviderFromPath('configs/gemini/cred.json');
        expect(m).not.toBeNull();
        expect(m.providerType).toBe('gemini-cli-oauth');
    });

    test('getProviderMappingByDirName', () => {
        const m = getProviderMappingByDirName('cursor');
        expect(m?.providerType).toBe('cursor-oauth');
    });

    test('createProviderConfig shape', () => {
        const p = createProviderConfig({
            credPathKey: 'GEMINI_OAUTH_CREDS_FILE_PATH',
            credPath: './c.json',
            defaultCheckModel: 'gemini-2.5-flash',
            needsProjectId: true,
            urlKeys: ['GEMINI_BASE_URL'],
        });
        expect(p.GEMINI_OAUTH_CREDS_FILE_PATH).toBe('./c.json');
        expect(p.uuid).toMatch(/^[0-9a-f-]{36}$/i);
        expect(p.PROJECT_ID).toBe('');
        expect(p.GEMINI_BASE_URL).toBe('');
    });

    test('addToUsedPaths and isPathLinked', () => {
        const s = new Set();
        addToUsedPaths(s, './configs/x.json');
        expect(isPathLinked('configs/x.json', s)).toBe(true);
    });

    test('formatSystemPath adds leading dot for relative', () => {
        const p = formatSystemPath('configs/foo.json');
        expect(p.startsWith('.')).toBe(true);
        expect(p).toContain('configs');
    });

    test('generateUUID matches v4 pattern', () => {
        const u = generateUUID();
        expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    test('isPathUsed matches filename in same logical dir', () => {
        const used = new Set(['./configs/gemini/a.json']);
        expect(isPathUsed('./configs/gemini/b.json', 'b.json', used)).toBe(false);
        expect(isPathUsed('./configs/gemini/a.json', 'a.json', used)).toBe(true);
    });

    test('isValidOAuthCredentials true for access_token JSON', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'oauth-'));
        const f = path.join(dir, 'c.json');
        await writeFile(f, JSON.stringify({ access_token: 'x', refresh_token: 'y' }), 'utf8');
        await expect(isValidOAuthCredentials(f)).resolves.toBe(true);
        await rm(dir, { recursive: true });
    });

    test('isValidOAuthCredentials false for invalid file', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'oauth-'));
        const f = path.join(dir, 'bad.json');
        await writeFile(f, 'not json', 'utf8');
        await expect(isValidOAuthCredentials(f)).resolves.toBe(false);
        await rm(dir, { recursive: true });
    });

    test('isValidOAuthCredentials true for installed OAuth2 structure', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'oauth-'));
        const f = path.join(dir, 'installed.json');
        await writeFile(f, JSON.stringify({ installed: { client_id: 'x', client_secret: 'y' } }), 'utf8');
        await expect(isValidOAuthCredentials(f)).resolves.toBe(true);
        await rm(dir, { recursive: true });
    });

    test('isValidOAuthCredentials false for valid JSON without OAuth fields', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'oauth-'));
        const f = path.join(dir, 'nooauth.json');
        await writeFile(f, JSON.stringify({ name: 'no-oauth', version: '1.0' }), 'utf8');
        await expect(isValidOAuthCredentials(f)).resolves.toBe(false);
        await rm(dir, { recursive: true });
    });

    test('detectProviderFromPath returns null for unknown path', () => {
        expect(detectProviderFromPath('configs/unknown-provider/cred.json')).toBeNull();
    });

    test('addToUsedPaths adds "./" prefix when path lacks it', () => {
        const s = new Set();
        addToUsedPaths(s, 'configs/gemini/cred.json'); // no './' prefix
        expect(s.has('./configs/gemini/cred.json')).toBe(true);
    });

    test('pathsEqual returns true when one path ends with the other', () => {
        // normalized1 ends with '/' + clean2
        expect(pathsEqual('/abs/configs/gemini/cred.json', 'cred.json')).toBe(true);
    });
});
