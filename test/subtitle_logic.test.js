const test = require('node:test');
const assert = require('node:assert/strict');
const {
    shouldShowExternalSubtitles,
    determineSubtitleRenderer,
    getCueTimes,
    findReplacementVideo,
    getCueSyncError,
    parseEpisode,
    compareEpisodes,
    shortenPaths,
    groupByEpisode,
    getDownloadCacheKey,
    hasUsableSubtitleFormat
} = require('../src/subtitle_logic');

test('shows external subtitles only when enabled, loaded, and bound to a video', () => {
    assert.equal(shouldShowExternalSubtitles(true, 1, true), true);
    assert.equal(shouldShowExternalSubtitles(false, 1, true), false);
    assert.equal(shouldShowExternalSubtitles(true, 0, true), false);
    assert.equal(shouldShowExternalSubtitles(true, 1, false), false);
});

test('selects the renderer from the fullscreen element', () => {
    const video = { tagName: 'VIDEO' };
    assert.equal(determineSubtitleRenderer(null, video), 'window-dom');
    assert.equal(determineSubtitleRenderer({ tagName: 'DIV' }, video), 'fullscreen-dom');
    assert.equal(determineSubtitleRenderer(video, video), 'text-track');
    assert.equal(determineSubtitleRenderer({ tagName: 'VIDEO' }, video), 'text-track');
});

test('applies positive and negative cue offsets safely', () => {
    assert.deepEqual(getCueTimes(1, 3, 2), { startTime: 3, endTime: 5 });
    assert.deepEqual(getCueTimes(1, 3, -2), { startTime: 0, endTime: 1 });
    assert.equal(getCueTimes(1, 2, -3), null);
    assert.equal(getCueTimes(2, 2, 0), null);
    assert.equal(getCueTimes(Number.NaN, 2, 0), null);
});

test('rebinds only to one visible replacement video', () => {
    const current = { visible: true };
    const replacement = { visible: true };
    const hidden = { visible: false };
    const isVisible = video => video.visible;

    assert.equal(findReplacementVideo(current, [current], isVisible), null);
    current.visible = false;
    assert.equal(findReplacementVideo(current, [current, replacement], isVisible), replacement);
    assert.equal(findReplacementVideo(current, [current, replacement, hidden], isVisible), replacement);
    assert.equal(findReplacementVideo(current, [current, replacement, { visible: true }], isVisible), null);
    replacement.visible = false;
    assert.equal(findReplacementVideo(current, [current, replacement], isVisible), null);
});

test('reports complete and partial cue sync failures', () => {
    assert.equal(
        getCueSyncError(2, 0, 0, null),
        'no valid cue times after applying the time offset'
    );
    assert.equal(
        getCueSyncError(2, 0, 2, 'bad cue'),
        '2 subtitle cue(s) could not be added: bad cue'
    );
    assert.equal(
        getCueSyncError(2, 1, 1, 'bad cue'),
        '1 subtitle cue(s) skipped; first error: bad cue'
    );
    assert.equal(getCueSyncError(2, 2, 0, null), null);
});

// ===== Archive subtitle selection =====

test('parseEpisode recognises common formats and keeps original label', () => {
    assert.deepEqual(parseEpisode('The.Show.S01E02.1080p.ass'), { season: 1, episode: 2, label: 'S01E02', pattern: 0 });
    assert.deepEqual(parseEpisode('The.Show.1x02.ass'), { season: 1, episode: 2, label: '1x02', pattern: 1 });
    assert.deepEqual(parseEpisode('The.Show.EP02.ass'), { season: 0, episode: 2, label: 'EP02', pattern: 2 });
    assert.deepEqual(parseEpisode('The.Show.E02.ass'), { season: 0, episode: 2, label: 'E02', pattern: 2 });
    assert.deepEqual(parseEpisode('The.Show.第02集.ass'), { season: 0, episode: 2, label: '第02集', pattern: 3 });
    assert.equal(parseEpisode('The.Show.Movie.ass'), null);
});

test('compareEpisodes sorts by season/episode, unparsed last', () => {
    const s1e2 = parseEpisode('a S01E02');
    const s1e10 = parseEpisode('a S01E10');
    const s2e1 = parseEpisode('a S02E01');
    assert.ok(compareEpisodes(s1e2, s1e10) < 0);
    assert.ok(compareEpisodes(s2e1, s1e2) > 0);
    assert.ok(compareEpisodes(null, s1e2) > 0);
    assert.ok(compareEpisodes(s1e2, null) < 0);
    assert.equal(compareEpisodes(null, null), 0);
});

test('shortenPaths drops common tokens and keeps differences', () => {
    const paths = [
        'The.Show.S01E01.1080p.WEB-DL.CHT.ass',
        'The.Show.S01E02.1080p.WEB-DL.CHT.ass'
    ];
    const out = shortenPaths(paths);
    assert.equal(out.length, 2);
    assert.match(out[0].text, /S01E01/);
    assert.match(out[1].text, /S01E02/);
    assert.equal(out[0].fullPath, paths[0]);
    assert.equal(out[1].fullPath, paths[1]);
});

test('shortenPaths keeps language tokens from folders', () => {
    const paths = ['CHT/01.ass', 'CHS/01.ass', 'Bilingual/01.ass'];
    const out = shortenPaths(paths);
    assert.match(out[0].text, /CHT/);
    assert.match(out[1].text, /CHS/);
    assert.match(out[2].text, /Bilingual/);
});

test('shortenPaths restores distinguishing text on collision', () => {
    // common head/tail leave identical middles -> restore until unique
    const paths = ['Show.1.ass', 'Show.1.ass.bak'];  // second not supported but tests collision logic
    const out = shortenPaths(paths);
    assert.equal(new Set(out.map(s => s.text)).size, 2);
});

test('shortenPaths keeps colliding labels unique when one path extends the other', () => {
    const out = shortenPaths(['S01.zh.ass', 'S01.zh.zh.ass']);
    assert.equal(new Set(out.map(s => s.text)).size, 2);
});

test('shortenPaths gives identical paths unique labels', () => {
    const out = shortenPaths(['Show.S01E02.1080p.WEB-DL.cht.ass', 'Show.S01E02.1080p.WEB-DL.cht.ass']);
    assert.equal(new Set(out.map(s => s.text)).size, 2);
    assert.match(out[1].text, /\(2\)$/);
});

test('shortenPaths only grows the clashing label', () => {
    const out = shortenPaths(['Show.CHT.ass', 'Show.CHT.ass', 'Show.CHS.ass']);
    assert.equal(new Set(out.map(s => s.text)).size, 3);
    assert.equal(out[2].text, '… CHS');
});

test('shortenPaths falls back to full path when nothing distinguishes', () => {
    const out = shortenPaths(['a.ass']);
    assert.equal(out[0].text, 'a');
    assert.equal(out[0].fullPath, 'a.ass');
});

test('groupByEpisode groups by episode label and sorts 其他 last', () => {
    const entries = [
        { path: 'Show.S01E02.CHT.ass' },
        { path: 'Show.S01E01.CHT.ass' },
        { path: 'Show.S01E01.CHS.ass' },
        { path: 'Movie.ass' }
    ];
    const groups = groupByEpisode(entries);
    assert.deepEqual(groups.map(g => g.label), ['S01E01', 'S01E02', '其他']);
    assert.equal(groups[0].items.length, 2); // E01: CHT + CHS
    assert.equal(groups[1].items.length, 1);
    assert.equal(groups[2].items.length, 1);
});

test('getDownloadCacheKey is stable and provider-scoped', () => {
    assert.equal(getDownloadCacheKey({ kind: 'os', file_id: 42 }), 'os:42');
    assert.equal(getDownloadCacheKey({ kind: 'assrt', id: 42 }), 'assrt:42');
    assert.equal(getDownloadCacheKey({ kind: 'subhd', id: 42 }), 'subhd:42');
    assert.notEqual(
        getDownloadCacheKey({ kind: 'assrt', id: 42 }),
        getDownloadCacheKey({ kind: 'subhd', id: 42 })
    );
    assert.equal(getDownloadCacheKey({ kind: 'assrt', id: 'abc' }), 'assrt:abc');
    assert.equal(getDownloadCacheKey({ kind: 'subhd' }), null);
    assert.equal(getDownloadCacheKey(null), null);
});

test('hasUsableSubtitleFormat drops SUP-only results', () => {
    assert.equal(hasUsableSubtitleFormat(['SUP']), false);
    assert.equal(hasUsableSubtitleFormat(['sup']), false);
    assert.equal(hasUsableSubtitleFormat(['SUP', 'ASS']), true);
    assert.equal(hasUsableSubtitleFormat(['SRT']), true);
    assert.equal(hasUsableSubtitleFormat([]), true);      // markup change: keep results
    assert.equal(hasUsableSubtitleFormat(null), true);
});

test('groupByEpisode keeps archive order within a group', () => {
    const entries = [
        { path: 'Show.S01E01.CHS.ass' },
        { path: 'Show.S01E01.CHT.ass' }
    ];
    const groups = groupByEpisode(entries);
    assert.equal(groups[0].items[0].path, 'Show.S01E01.CHS.ass');
    assert.equal(groups[0].items[1].path, 'Show.S01E01.CHT.ass');
});
