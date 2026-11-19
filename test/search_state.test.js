const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createSearchState,
    captureSearchView,
    restoreSearchView,
    resetSubhdState,
    isLanguageOnlyChange,
    findSearchCandidate
} = require('../src/search_state');

test('search state starts empty and groups SubHD state', () => {
    const state = createSearchState();
    assert.deepEqual(state.results, []);
    assert.equal(state.page, 1);
    assert.equal(state.loading, false);
    assert.equal(state.downloadCache, null);
    assert.deepEqual(state.subhd, {
        query: '',
        candidates: [],
        selected: null,
        rows: [],
        fallback: []
    });
});

test('search view snapshot restores list, page, path, and view', () => {
    const state = createSearchState();
    state.results = [{ id: 1 }];
    state.page = 2;
    state.path = [{ label: 'SubHD' }];
    state.view = { kind: 'episode' };
    const snapshot = captureSearchView(state);

    state.results = [];
    state.page = 1;
    state.path = [];
    state.view = null;
    restoreSearchView(state, snapshot);

    assert.equal(state.results, snapshot.results);
    assert.equal(state.path, snapshot.path);
    assert.equal(state.page, 2);
    assert.deepEqual(state.view, { kind: 'episode' });
});

test('resetSubhdState clears transient selection and keeps supplied response data', () => {
    const state = createSearchState();
    state.subhd.selected = { id: 'old' };
    state.subhd.rows = [{ id: 1 }];
    resetSubhdState(state, {
        query: 'Inception',
        candidates: [{ id: 'new' }],
        fallback: [{ id: 2 }]
    });
    assert.equal(state.subhd.query, 'Inception');
    assert.deepEqual(state.subhd.candidates, [{ id: 'new' }]);
    assert.deepEqual(state.subhd.fallback, [{ id: 2 }]);
    assert.equal(state.subhd.selected, null);
    assert.deepEqual(state.subhd.rows, []);
});

test('isLanguageOnlyChange only fires for the same query and provider', () => {
    const previous = { provider: 'subhd', query: 'Inception', language: 'all' };
    assert.equal(isLanguageOnlyChange(previous, { provider: 'subhd', query: 'Inception', language: 'zh-hant' }), true);
    assert.equal(isLanguageOnlyChange(previous, { provider: 'subhd', query: 'Inception', language: 'all' }), false);
    assert.equal(isLanguageOnlyChange(previous, { provider: 'assrt', query: 'Inception', language: 'zh-hant' }), false);
    assert.equal(isLanguageOnlyChange(previous, { provider: 'subhd', query: 'Interstellar', language: 'zh-hant' }), false);
    assert.equal(isLanguageOnlyChange(null, { provider: 'subhd', query: 'Inception', language: 'zh-hant' }), false);
});

test('findSearchCandidate matches by id, then title, else gives up', () => {
    const candidates = [{ id: '10', title: 'Inception' }, { id: '11', title: 'Interstellar' }];
    assert.equal(findSearchCandidate(candidates, { id: '11', title: 'Interstellar' }), candidates[1]);
    assert.equal(findSearchCandidate(candidates, { id: '99', title: 'Inception' }), candidates[0]);
    assert.equal(findSearchCandidate(candidates, { id: '99', title: 'Dunkirk' }), null);
    assert.equal(findSearchCandidate(candidates, null), null);
});
