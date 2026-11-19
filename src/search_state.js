function createSearchState() {
    return {
        results: [],
        page: 1,
        path: [],
        view: null,
        loading: false,
        downloadCache: null,
        archivePicker: null,
        subhd: {
            query: '',
            candidates: [],
            selected: null,
            rows: [],
            fallback: []
        }
    };
}

function captureSearchView(state) {
    return {
        results: state.results,
        page: state.page,
        path: state.path,
        view: state.view
    };
}

function restoreSearchView(state, snapshot) {
    state.results = snapshot.results;
    state.page = snapshot.page;
    state.path = snapshot.path;
    state.view = snapshot.view;
}

function resetSubhdState(state, options = {}) {
    state.subhd.query = options.query || '';
    state.subhd.candidates = options.candidates || [];
    state.subhd.selected = null;
    state.subhd.rows = [];
    state.subhd.fallback = options.fallback || [];
}

// Same query and provider with a new language: the view can be rebuilt in place
function isLanguageOnlyChange(previous, current) {
    return Boolean(previous && current)
        && previous.provider === current.provider
        && previous.query === current.query
        && previous.language !== current.language;
}

function findSearchCandidate(candidates, previous) {
    const list = candidates || [];
    if (!previous) return null;
    if (previous.id !== undefined && previous.id !== null) {
        const byId = list.find(function(candidate){ return candidate.id === previous.id; });
        if (byId) return byId;
    }
    return list.find(function(candidate){ return candidate.title === previous.title; }) || null;
}

module.exports = {
    createSearchState,
    captureSearchView,
    restoreSearchView,
    resetSubhdState,
    isLanguageOnlyChange,
    findSearchCandidate
};
