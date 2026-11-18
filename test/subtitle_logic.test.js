const test = require('node:test');
const assert = require('node:assert/strict');
const {
    shouldShowExternalSubtitles,
    determineSubtitleRenderer,
    getCueTimes,
    findReplacementVideo,
    getCueSyncError
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
