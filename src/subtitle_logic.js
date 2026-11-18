function shouldShowExternalSubtitles(isChecked, subtitleCount, hasVideo) {
    return Boolean(isChecked && subtitleCount > 0 && hasVideo);
}

function determineSubtitleRenderer(fullscreenElement, video) {
    if (!fullscreenElement) return "window-dom";
    if (fullscreenElement === video || fullscreenElement.tagName === "VIDEO") {
        return "text-track";
    }
    return "fullscreen-dom";
}

function getCueTimes(begin, end, offset) {
    const startTime = Math.max(0, begin + offset);
    const endTime = Math.max(0, end + offset);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) ||
        endTime <= startTime || endTime <= 0) {
        return null;
    }
    return { startTime, endTime };
}

function findReplacementVideo(currentVideo, videos, isVisible) {
    if (currentVideo && isVisible(currentVideo)) return null;
    const visibleVideos = videos.filter(isVisible);
    return visibleVideos.length === 1 ? visibleVideos[0] : null;
}

function getCueSyncError(subtitleCount, addedCount, failedCount, firstErrorMessage) {
    if (subtitleCount > 0 && addedCount === 0) {
        return failedCount > 0
            ? `${failedCount} subtitle cue(s) could not be added: ${firstErrorMessage}`
            : "no valid cue times after applying the time offset";
    }
    if (failedCount > 0) {
        return `${failedCount} subtitle cue(s) skipped; first error: ${firstErrorMessage}`;
    }
    return null;
}

// ===== Archive subtitle selection helpers =====

// Episode patterns: S01E02 / 1x02, E02, EP02, 第02集. First match wins.
const EPISODE_PATTERNS = [
    /S(\d{1,2})\s?E(\d{1,3})/i,
    /(\d{1,2})x(\d{1,3})/,
    /[.\s_-][EP]{1,2}(\d{1,3})(?![\dp])/i,
    /第\s*(\d{1,3})\s*[集話话]/
];

// [reason] parse only; display keeps the original text via match index
function parseEpisode(path) {
    for (let i = 0; i < EPISODE_PATTERNS.length; i++) {
        const m = path.match(EPISODE_PATTERNS[i]);
        if (m) {
            const season = m.length > 2 ? parseInt(m[1], 10) : 0;
            const episode = parseInt(m[m.length > 2 ? 2 : 1], 10);
            // drop the leading separator the pattern consumed (.EP02 -> EP02)
            const label = m[0].replace(/^[.\s_-]+/, '');
            return { season, episode, label, pattern: i };
        }
    }
    return null;
}

function compareEpisodes(a, b) {
    if (a === null && b === null) return 0;
    if (a === null) return 1;  // "其他" last
    if (b === null) return -1;
    return a.season - b.season || a.episode - b.episode || a.pattern - b.pattern;
}

// Shorten a set of relative paths to their distinguishing parts.
// [reason] splits on . _ - spaces and brackets so CHT/雙語 tokens survive;
// common head/tail token runs are dropped, `…` marks elision. Only the items that
// collide (or elide to nothing) grow back, and each grows just far enough to be
// unique against the labels already assigned; identical paths get a counter.
function shortenPaths(paths) {
    const stripExt = p => p.replace(/\.[a-z0-9]{2,4}$/i, '');
    if (paths.length < 2) {
        // nothing to common-trim; strip extension only
        return paths.map(function(p){
            return { text: stripExt(p), fullPath: p };
        });
    }
    const tokens = paths.map(function(p){
        return stripExt(p).split(/[.\s_\-\[\]()]+/).filter(Boolean);
    });
    let head = 0;
    while (head < tokens[0].length) {
        const t = tokens[0][head];
        if (tokens.some(tk => tk[head] !== t)) break;
        head++;
    }
    let tail = 0;
    while (tail < tokens[0].length - head) {
        const t = tokens[0][tokens[0].length - 1 - tail];
        if (tokens.some(tk => tk[tk.length - 1 - tail] !== t)) break;
        tail++;
    }
    const result = [];
    const used = new Set();
    const seen = new Map();
    for (let i = 0; i < paths.length; i++) {
        const tk = tokens[i];
        // identical path: no token window can separate them, so number the repeats
        const repeat = seen.get(paths[i]);
        if (repeat !== undefined) {
            let n = 2;
            let text = repeat;
            do { text = repeat + ' (' + n + ')'; n++; } while (used.has(text));
            used.add(text);
            result.push({ text, fullPath: paths[i] });
            continue;
        }
        let chosen = null;
        // extra = how many neighbouring tokens to restore; try the cheapest first
        for (let extra = 0; extra <= head + tail && chosen === null; extra++) {
            for (let left = 0; left <= extra; left++) {
                const right = extra - left;
                if (left > head || right > tail) continue;
                const text = tk.slice(head - left, tk.length - tail + right).join(' ');
                if (text && !used.has(text)) { chosen = { text, left, right }; break; }
            }
        }
        if (chosen === null) {
            // nothing distinguishes it: fall back to the full path, then a counter
            let text = paths[i];
            let n = 2;
            while (used.has(text)) { text = paths[i] + ' (' + n + ')'; n++; }
            chosen = { text, left: head, right: tail };
        }
        used.add(chosen.text);
        seen.set(paths[i], chosen.text);
        result.push({
            text: (head - chosen.left > 0 ? '… ' : '') + chosen.text + (tail - chosen.right > 0 ? ' …' : ''),
            fullPath: paths[i]
        });
    }
    return result;
}

// Group candidates by parsed episode; "其他" group holds unparsed entries.
// Each group: { key, label, ep, items } where items keep the caller's fields
// (path, ext, getText, ...) plus a `short` display label.
function groupByEpisode(entries) {
    // entries: [{ path }] in archive order
    const parsed = entries.map(e => ({ ...e, ep: parseEpisode(e.path) }));
    const groups = new Map();
    for (const e of parsed) {
        const key = e.ep ? e.ep.label : '其他';
        if (!groups.has(key)) {
            groups.set(key, {
                key,
                label: e.ep ? e.ep.label : '其他',
                ep: e.ep,
                items: []
            });
        }
        // carry caller fields (ext, getText, ...) through to the group items
        const item = Object.assign({}, e);
        delete item.ep;
        groups.get(key).items.push(item);
    }
    const list = Array.from(groups.values());
    list.sort((a, b) => compareEpisodes(a.ep, b.ep));
    for (const g of list) {
        const shorts = shortenPaths(g.items.map(it => it.path));
        shorts.forEach((s, i) => { g.items[i].short = s.text; });
    }
    return list;
}

// Stable identity for a downloaded subtitle result; the provider prefix keeps
// numeric IDs from different sources from colliding.
function getDownloadCacheKey(pay) {
    if (!pay) return null;
    if (pay.kind === 'os' && pay.file_id) return 'os:' + pay.file_id;
    if ((pay.kind === 'assrt' || pay.kind === 'subhd') && pay.id) return pay.kind + ':' + pay.id;
    return null;
}

// Subtitle formats the parser can actually read; SUP (image subtitles) cannot.
const SUBTITLE_FORMATS = ['srt', 'vtt', 'ass', 'ssa'];

// SubHD results tagged only SUP cannot be used by the player.
// No tags at all counts as usable so a markup change does not drop every result.
function hasUsableSubtitleFormat(formatTokens) {
    const tokens = (formatTokens || []).map(t => String(t).toLowerCase());
    if (!tokens.length) return true;
    return tokens.some(t => SUBTITLE_FORMATS.indexOf(t) !== -1);
}

module.exports = {
    SUBTITLE_FORMATS,
    getDownloadCacheKey,
    hasUsableSubtitleFormat,
    shouldShowExternalSubtitles,
    determineSubtitleRenderer,
    getCueTimes,
    findReplacementVideo,
    getCueSyncError,
    parseEpisode,
    compareEpisodes,
    shortenPaths,
    groupByEpisode
};
