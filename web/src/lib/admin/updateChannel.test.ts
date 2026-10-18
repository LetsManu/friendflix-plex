// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { hasKey, setLocale, tr } from '#lib/i18n';
import { buildInfo, loadBuild, parseBuild, versionText } from '#lib/version/build';
import { CHANNELS, PULL_COMMAND, envLineFor, isUpToDate, showSnippet, snippetReason, stepChannel, type ChannelInfo } from './updateChannel';

const ch = (over: Partial<ChannelInfo> = {}): ChannelInfo => ({ selected: 'stable', running: 'stable', build: 'release', label: '1.1.0', locked: false, envLine: 'FF_TAG=latest', ...over });

afterEach(async () => { await setLocale('de'); });

describe('build info (footer, /api/version)', () => {
  it('parses leniently: older backends and junk give null', () => {
    expect(parseBuild({ sha: 'x', version: '1.1.0', codename: 'Arancini' })).toBeNull();
    expect(parseBuild(null)).toBeNull();
    expect(parseBuild({ sha: 'x', build: 'weird', label: '1' })).toBeNull();
    expect(parseBuild({ sha: 'abc', build: 'nightly', channel: 'nightly', label: '1.1.0-nightly · abc1234' }))
      .toEqual({ sha: 'abc', build: 'nightly', channel: 'nightly', label: '1.1.0-nightly · abc1234' });
    expect(parseBuild({ sha: 'dev', build: 'dev', channel: null, label: '1.1.0' })?.channel).toBeNull();
  });
  it('version text: "-nightly · sha" only for a nightly build; release, dev and unknown stay as today', () => {
    expect(versionText('1.1.0', 'Arancini', null)).toBe('1.1.0 · Arancini');
    expect(versionText('1.1.0', 'Arancini', { sha: 'a', build: 'release', channel: 'stable', label: '1.1.0' })).toBe('1.1.0 · Arancini');
    expect(versionText('1.1.0', 'Arancini', { sha: 'dev', build: 'dev', channel: null, label: '1.1.0' })).toBe('1.1.0 · Arancini');
    expect(versionText('1.1.0', 'Arancini', { sha: 'b', build: 'nightly', channel: 'nightly', label: '1.1.0-nightly · abc1234' })).toBe('1.1.0-nightly · abc1234');
    expect(versionText('1.1.0', '', null)).toBe('1.1.0');
  });
  it('loadBuild asks once and fills the store; a failure leaves it empty', async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response(JSON.stringify({ sha: 'b', build: 'nightly', channel: 'nightly', label: '1.1.0-nightly · bbbbbbb' })); }) as unknown as typeof fetch;
    loadBuild(f);
    loadBuild(f);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);
    expect(get(buildInfo)?.label).toBe('1.1.0-nightly · bbbbbbb');
  });
});

describe('update channel', () => {
  it('the .env line and the pull command of the production stack', () => {
    expect(CHANNELS).toEqual(['stable', 'nightly', 'pinned']);
    expect(envLineFor('stable')).toBe('FF_TAG=latest');
    expect(envLineFor('nightly')).toBe('FF_TAG=nightly');
    expect(envLineFor('pinned', '1.2.3')).toBe('FF_TAG=1.2.3');
    expect(envLineFor('pinned')).toBe('FF_TAG=latest');
    expect(PULL_COMMAND).toBe('docker compose -f compose.prod.yaml -f compose.plex.yaml pull && docker compose -f compose.prod.yaml -f compose.plex.yaml up -d');
  });
  it('the snippet: selection differs from the running channel, or an update exists', () => {
    expect(showSnippet({ updateAvailable: false, channel: ch() })).toBe(false);
    expect(showSnippet({ updateAvailable: true, channel: ch() })).toBe(true);
    expect(snippetReason({ updateAvailable: true, channel: ch() })).toBe('update');
    const sw = { updateAvailable: false, channel: ch({ selected: 'nightly', envLine: 'FF_TAG=nightly' }) };
    expect(showSnippet(sw)).toBe(true);
    expect(snippetReason(sw)).toBe('switch');
    // unknown running channel (GitHub down) or a dev build: no switch hint
    expect(showSnippet({ updateAvailable: false, channel: ch({ running: null, build: null, selected: 'nightly' }) })).toBe(false);
    expect(showSnippet({ updateAvailable: null, channel: ch({ running: null, build: 'dev' }) })).toBe(false);
    expect(showSnippet({ updateAvailable: true })).toBe(false); // older backend
    // a fixed version: a switch only when it is not the installed one (a release build runs on stable)
    const pin = (updateAvailable: boolean | null) => ({ updateAvailable, channel: ch({ selected: 'pinned', version: '1.1.0', envLine: 'FF_TAG=1.1.0' }) });
    expect(showSnippet(pin(false))).toBe(false);
    expect(showSnippet(pin(true))).toBe(true);
    expect(snippetReason(pin(true))).toBe('switch');
  });
  it('up to date on the selected channel; older backends fall back to the commit comparison', () => {
    expect(isUpToDate({ updateAvailable: false, behind: 7 })).toBe(true); // stable: main moving on is no update
    expect(isUpToDate({ updateAvailable: true, behind: 0 })).toBe(false);
    expect(isUpToDate({ updateAvailable: null, behind: 0 })).toBe(true);
    expect(isUpToDate({ updateAvailable: null, behind: 3 })).toBe(false);
    expect(isUpToDate({ updateAvailable: null, behind: null })).toBe(false);
  });
  it('arrow keys move through the segmented switch', () => {
    expect(stepChannel('stable', 'ArrowRight')).toBe('nightly');
    expect(stepChannel('nightly', 'ArrowRight')).toBe('pinned');
    expect(stepChannel('pinned', 'ArrowRight')).toBe('stable');
    expect(stepChannel('stable', 'ArrowLeft')).toBe('pinned');
    expect(stepChannel('stable', 'Enter')).toBeNull();
  });
  it('every string exists in all seven languages', async () => {
    const keys = ['title', 'label', 'stable', 'nightly', 'running', 'runningStable', 'runningNightly', 'runningDev', 'runningUnknown', 'stableHint', 'nightlyHint',
      'locked', 'saved', 'nightlyBuild', 'switchLead', 'updateLead', 'envLabel', 'cmdLabel', 'note', 'pinned', 'pinnedHint', 'versionLabel', 'versionSave', 'versionInvalid', 'updaterNote'];
    const de = Object.fromEntries(keys.map((k) => [k, tr(`admin.update.channel.${k}` as 'admin.update.channel.title')]));
    for (const l of ['en', 'es', 'fr', 'it', 'pl', 'tr']) {
      await setLocale(l);
      for (const k of keys) {
        expect(hasKey(`admin.update.channel.${k}`), `${l} ${k}`).toBe(true);
        // "Nightly", "Nightly · Build {sha}" and "Version (X.Y.Z)" may be the same; everything else is translated
        if (!['nightly', 'nightlyBuild', 'runningNightly', 'versionLabel'].includes(k)) expect(tr(`admin.update.channel.${k}` as 'admin.update.channel.title'), `${l} ${k}`).not.toBe(de[k]);
      }
    }
    await setLocale('en');
    expect(tr('admin.update.channel.note')).toContain('never touches Docker');
  });
});
