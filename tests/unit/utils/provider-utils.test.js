import { describe, test, expect } from '@jest/globals';
import {
    normalizePath,
    getFileName,
    pathsEqual,
    detectProviderFromPath,
    getProviderMappingByDirName,
    createProviderConfig,
    addToUsedPaths,
    isPathLinked,
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
});
