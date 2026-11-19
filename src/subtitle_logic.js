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

function archivePathLabel(name, maxLength = 20) {
    const full = name || '壓縮檔';
    if (!name || name.length <= maxLength) return { label: full, title: full };
    const cut = name.slice(0, maxLength - 1).replace(/[\s.\-_\[\]]+$/, '');
    return { label: cut + '…', title: name };
}

function hasSubhdEpisodeLayer(rows) {
    const labels = new Set((rows || []).map(row => row.episode || ''));
    return labels.size > 1 && Array.from(labels).some(Boolean);
}

// Display the work title in the query's language: SubHD cards carry a bilingual
// poster alt ("盗梦空间 Inception") while the bold /a/ link is Chinese-only.
function subhdTitleForQuery(title, alt, query) {
    const primary = String(title || '').trim();
    const fallback = primary || String(alt || '').trim();
    if (/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(String(query || ''))) {
        return fallback;
    }
    const latin = String(alt || '')
        .replace(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g, ' ')
        .replace(/[《》「」『』【】〔〕（）〈〉、，。：；！？·～—…“”‘’]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return /[A-Za-z]/.test(latin) ? latin : fallback;
}

// SubHD episode labels are scraped Chinese; show them in the query's language.
function subhdLabel(text, query) {
    const label = String(text || '');
    if (/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(String(query || ''))) return label;
    if (label === '全部集數') return 'All episodes';
    if (label === '全部字幕') return 'All subtitles';
    if (label === '未分集') return 'Unlabeled';
    const collection = label.match(/^合集\s*(.*)$/);
    if (collection) return 'Collection' + (collection[1] ? ' ' + collection[1] : '');
    const episode = label.match(/^第\s*(\d+)\s*集$/);
    if (episode) return 'Episode ' + episode[1];
    return label;
}

function subhdCountText(count, query) {
    if (/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(String(query || ''))) {
        return count + ' 筆';
    }
    return count + (count === 1 ? ' subtitle' : ' subtitles');
}

// SubHD labels each subtitle with its own language tags (简体/繁体/英语/双语).
function subhdLanguageMatch(tags, language) {
    if (language === 'all') return true;
    const set = new Set(tags || []);
    if (language === 'zh-hans') return set.has('简体') || set.has('双语');
    if (language === 'zh-hant') return set.has('繁体') || set.has('双语');
    if (language === 'en') return set.has('英语') || set.has('双语');
    return false;
}

// Display labels keep SubHD's own wording, with Traditional characters for 繁體/雙語.
const SUBHD_LANGUAGE_LABELS = { '繁体': '繁體', '双语': '雙語', '英语': 'English' };
function subhdLanguageLabel(tag) {
    return SUBHD_LANGUAGE_LABELS[tag] || tag;
}

// 合集 first, 第 N 集 ascending, anything unparsed last.
function subhdEpisodeSortKey(label) {
    const text = String(label || '');
    if (text.indexOf('合集') !== -1) return -1;
    const match = text.match(/第\s*(\d+)\s*集/);
    return match ? parseInt(match[1], 10) : Number.POSITIVE_INFINITY;
}

function getPagedResults(results, page, size) {
    const safePage = Math.max(1, page || 1);
    const start = (safePage - 1) * size;
    return { page: safePage, items: results.slice(start, start + size) };
}

async function runArchiveSelection(item, progress, load) {
    try {
        return await load(item);
    } finally {
        progress.hide();
    }
}

function buildPickerBaseSegments(segments, leave) {
    const list = segments || [];
    return list.map(function(segment, index) {
        const isCurrent = index === list.length - 1;
        return {
            label: segment.label,
            title: segment.title,
            on_click: segment.on_click || isCurrent
                ? function() {
                    leave();
                    if (segment.on_click) segment.on_click();
                }
                : null
        };
    });
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

function parseSubtitleColor(value) {
    const input = String(value || '').trim();
    let red;
    let green;
    let blue;
    let alpha = 1;
    const hex = input.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i);
    const rgb = input.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d*(?:\.\d+)?))?\s*\)$/i);

    if (hex) {
        const raw = hex[1];
        const expanded = raw.length < 5
            ? raw.split('').map(char => char + char).join('')
            : raw;
        red = parseInt(expanded.slice(0, 2), 16);
        green = parseInt(expanded.slice(2, 4), 16);
        blue = parseInt(expanded.slice(4, 6), 16);
        if (expanded.length === 8) alpha = parseInt(expanded.slice(6, 8), 16) / 255;
    } else if (rgb) {
        red = Number(rgb[1]);
        green = Number(rgb[2]);
        blue = Number(rgb[3]);
        alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
        if ([red, green, blue, alpha].some(number => !Number.isFinite(number)) ||
            red > 255 || green > 255 || blue > 255 || alpha < 0 || alpha > 1) {
            return null;
        }
    } else {
        return null;
    }

    const toHex = number => Math.round(number).toString(16).padStart(2, '0');
    const roundedAlpha = Math.round(alpha * 1000) / 1000;
    return {
        hex: '#' + toHex(red) + toHex(green) + toHex(blue),
        alpha: roundedAlpha,
        rgba: `rgba(${Math.round(red)}, ${Math.round(green)}, ${Math.round(blue)}, ${roundedAlpha})`
    };
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
    groupByEpisode,
    archivePathLabel,
    hasSubhdEpisodeLayer,
    subhdEpisodeSortKey,
    subhdTitleForQuery,
    subhdLabel,
    subhdCountText,
    subhdLanguageMatch,
    subhdLanguageLabel,
    getPagedResults,
    runArchiveSelection,
    buildPickerBaseSegments,
    parseSubtitleColor
};
