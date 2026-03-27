#!/usr/bin/env node

/**
 * Upstream Repository Monitor
 *
 * Checks CLIProxyAPI and CLIProxyAPIPlus for new commits, providers, and features.
 * Run: node scripts/check-upstream.js
 */

import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';

const UPSTREAM_REPOS = [
    {
        name: 'CLIProxyAPI',
        repo: 'router-for-me/CLIProxyAPI',
        branch: 'main',
    },
    {
        name: 'CLIProxyAPIPlus',
        repo: 'router-for-me/CLIProxyAPIPlus',
        branch: 'main',
    },
];

const CHECKPOINT_FILE = path.join(process.cwd(), 'configs', 'upstream-checkpoint.json');

// Directories that indicate new providers or important features
const WATCH_PATHS = [
    'internal/auth/',
    'internal/runtime/executor/',
    'internal/translator/',
    'internal/thinking/',
    'sdk/auth/',
];

async function loadCheckpoint() {
    try {
        const raw = await fs.readFile(CHECKPOINT_FILE, 'utf8');
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

async function saveCheckpoint(checkpoint) {
    await fs.mkdir(path.dirname(CHECKPOINT_FILE), { recursive: true });
    await fs.writeFile(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2), 'utf8');
}

function ghApi(endpoint) {
    try {
        const result = execSync(`gh api "${endpoint}"`, { encoding: 'utf8', timeout: 30000 });
        return JSON.parse(result);
    } catch (err) {
        console.error(`  Failed to call GitHub API: ${endpoint}`);
        console.error(`  ${err.message}`);
        return null;
    }
}

function analyzeCommits(commits) {
    const newProviders = [];
    const bugfixes = [];
    const features = [];
    const breaking = [];

    for (const commit of commits) {
        const msg = commit.commit?.message || '';
        const files = commit.files?.map(f => f.filename) || [];
        const firstLine = msg.split('\n')[0];

        // Detect new providers by new auth directories
        for (const file of files) {
            for (const watchPath of WATCH_PATHS) {
                if (file.startsWith(watchPath) && commit.stats?.additions > 50) {
                    const pathParts = file.replace(watchPath, '').split('/');
                    if (pathParts[0] && !pathParts[0].includes('.')) {
                        newProviders.push({ provider: pathParts[0], commit: firstLine, sha: commit.sha?.slice(0, 7) });
                    }
                }
            }
        }

        // Categorize by conventional commit prefix
        if (firstLine.startsWith('feat')) features.push({ msg: firstLine, sha: commit.sha?.slice(0, 7) });
        else if (firstLine.startsWith('fix')) bugfixes.push({ msg: firstLine, sha: commit.sha?.slice(0, 7) });
        else if (firstLine.includes('BREAKING') || firstLine.includes('!:')) breaking.push({ msg: firstLine, sha: commit.sha?.slice(0, 7) });
    }

    // Deduplicate providers
    const uniqueProviders = [...new Map(newProviders.map(p => [p.provider, p])).values()];

    return { newProviders: uniqueProviders, bugfixes, features, breaking };
}

async function checkRepo(repoConfig, checkpoint) {
    const { name, repo, branch } = repoConfig;
    const lastSha = checkpoint[name]?.lastSha;

    console.log(`\n--- ${name} (${repo}) ---`);

    // Get latest commit
    const latestCommits = ghApi(`repos/${repo}/commits?sha=${branch}&per_page=1`);
    if (!latestCommits || latestCommits.length === 0) {
        console.log('  No commits found or API error');
        return null;
    }

    const latestSha = latestCommits[0].sha;

    if (lastSha === latestSha) {
        console.log('  No new commits since last check');
        return { name, sha: latestSha, changes: null };
    }

    // Get commits since last check
    let commitsUrl = `repos/${repo}/commits?sha=${branch}&per_page=50`;
    if (lastSha) {
        commitsUrl += `&since=${checkpoint[name]?.checkedAt || ''}`;
    }

    const commits = ghApi(commitsUrl);
    if (!commits || commits.length === 0) {
        return { name, sha: latestSha, changes: null };
    }

    const newCommitCount = lastSha
        ? commits.findIndex(c => c.sha === lastSha)
        : commits.length;

    const newCommits = commits.slice(0, newCommitCount === -1 ? commits.length : newCommitCount);

    console.log(`  ${newCommits.length} new commits`);

    // Get file details for important commits (limit to 10)
    const detailedCommits = [];
    for (const commit of newCommits.slice(0, 10)) {
        const detail = ghApi(`repos/${repo}/commits/${commit.sha}`);
        if (detail) detailedCommits.push(detail);
    }

    const analysis = analyzeCommits(detailedCommits);

    // Print report
    if (analysis.newProviders.length > 0) {
        console.log(`  NEW PROVIDERS:`);
        for (const p of analysis.newProviders) {
            console.log(`    - ${p.provider} (${p.sha}: ${p.commit})`);
        }
    }

    if (analysis.features.length > 0) {
        console.log(`  FEATURES (${analysis.features.length}):`);
        for (const f of analysis.features.slice(0, 5)) {
            console.log(`    - ${f.sha}: ${f.msg}`);
        }
        if (analysis.features.length > 5) {
            console.log(`    ... and ${analysis.features.length - 5} more`);
        }
    }

    if (analysis.bugfixes.length > 0) {
        console.log(`  BUGFIXES (${analysis.bugfixes.length}):`);
        for (const b of analysis.bugfixes.slice(0, 5)) {
            console.log(`    - ${b.sha}: ${b.msg}`);
        }
    }

    if (analysis.breaking.length > 0) {
        console.log(`  BREAKING CHANGES:`);
        for (const b of analysis.breaking) {
            console.log(`    - ${b.sha}: ${b.msg}`);
        }
    }

    if (analysis.newProviders.length === 0 && analysis.features.length === 0 && analysis.bugfixes.length === 0) {
        console.log('  No notable changes detected');
    }

    return { name, sha: latestSha, changes: analysis };
}

async function main() {
    console.log('=== Upstream Repository Monitor ===');
    console.log(`Date: ${new Date().toISOString()}\n`);

    const checkpoint = await loadCheckpoint();
    const results = [];

    for (const repo of UPSTREAM_REPOS) {
        const result = await checkRepo(repo, checkpoint);
        if (result) {
            results.push(result);
            checkpoint[result.name] = {
                lastSha: result.sha,
                checkedAt: new Date().toISOString(),
            };
        }
    }

    await saveCheckpoint(checkpoint);

    // Summary
    console.log('\n=== Summary ===');
    const allNewProviders = results.flatMap(r => r.changes?.newProviders || []);
    const allFeatures = results.flatMap(r => r.changes?.features || []);
    const allBreaking = results.flatMap(r => r.changes?.breaking || []);

    if (allNewProviders.length > 0) {
        console.log(`\nACTION NEEDED: ${allNewProviders.length} new provider(s) detected!`);
        for (const p of allNewProviders) {
            console.log(`  -> ${p.provider}: Consider migrating to AIClient-2-API`);
        }
    }

    if (allBreaking.length > 0) {
        console.log(`\nWARNING: ${allBreaking.length} breaking change(s) detected!`);
    }

    if (allNewProviders.length === 0 && allFeatures.length === 0 && allBreaking.length === 0) {
        console.log('No notable upstream changes. All good!');
    }

    console.log(`\nCheckpoint saved to: ${CHECKPOINT_FILE}`);
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
