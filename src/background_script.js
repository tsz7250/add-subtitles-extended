// [reason] chrome.* with callbacks works in both Chrome and Firefox WebExtensions.
function executeScript(tabId, options, targetOptions = {}) {
    return new Promise((resolve, reject) => {
        chrome.scripting.executeScript({
            target: { tabId, ...targetOptions },
            ...options
        }, results => {
            const error = chrome.runtime.lastError;
            if (error) {
                reject(new Error(error.message));
                return;
            }
            resolve(results.map(result => result.result));
        });
    });
}

// Chinese conversion is bundled into add_subtitles.js via npm packages.

const openFrameMenuId = 'open-current-frame';

function openCurrentFrameInNewTab() {
    return window.open(location.href, '_blank') !== null;
}

function createOpenFrameContextMenu() {
    chrome.contextMenus.create({
        id: openFrameMenuId,
        title: 'Open This Frame in New Tab',
        contexts: ['frame', 'video']
    });
}

chrome.runtime.onInstalled.addListener(createOpenFrameContextMenu);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== openFrameMenuId) {
        return;
    }

    const frameUrl = info.frameUrl || info.pageUrl;
    if (!frameUrl || !/^https?:\/\//i.test(frameUrl) || !tab?.id) {
        return;
    }

    if (Number.isInteger(info.frameId)) {
        try {
            const results = await executeScript(
                tab.id,
                { func: openCurrentFrameInNewTab },
                { frameIds: [info.frameId] }
            );
            if (results[0]) {
                return;
            }
        } catch (error) {
            console.warn('Opening frame from its document failed:', error);
        }
    }

    chrome.tabs.create({
        url: frameUrl,
        openerTabId: tab.id
    });
});

// Function to inject all content scripts
async function injectContentScripts(tabId) {
    console.log('Injecting content scripts for tab:', tabId);

    try {
        await executeScript(tabId, { files: ["content_scripts/add_subtitles.js"] });
        console.log('Content script injection completed');
    } catch (error) {
        console.error('Content script injection failed:', error);
        throw error;
    }
}

// Browser action button handler
chrome.action.onClicked.addListener(async function(tab) {
    console.log('Button clicked for tab:', tab.id);
    console.log('Tab URL:', tab.url);
    await injectContentScripts(tab.id);
});

// Message listener for re-injection requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Received message:', message);

    if (message.action === 'reinject_opencc' && sender.tab && sender.tab.id) {
        console.log('Re-injection request from tab:', sender.tab.id);
        injectContentScripts(sender.tab.id)
            .then(() => {
                console.log('Re-injection completed');
                sendResponse({ success: true, message: 'Scripts re-injected' });
            })
            .catch(error => {
                console.error('Re-injection failed:', error);
                sendResponse({ success: false, error: error.message });
            });
        return true;
    }
});

// ===== Online subtitle search: generic fetchers for the content script =====
// [reason] content script fetch is CORS-bound by the page origin; the service
// worker fetch with host_permissions <all_urls> bypasses CORS.
const SUB_FETCH_MAX_BYTES = 20 * 1024 * 1024;

function binaryToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

// SubHD rejects (403 "无法准备下载，请返回字幕详情页重试") requests whose Origin
// header is an extension origin, AND requests carrying a Sec-Fetch-Site header with
// any value other than same-origin (Chrome service-worker fetches send "none";
// Firefox omits Fetch Metadata headers entirely, which passes). Origin is a
// forbidden header for fetch, so fix both via a declarativeNetRequest session rule
// scoped to our own requests.
const SUBHD_DNR_RULE_ID = 990001;
const SUBHD_DOMAINS = ['subhd.me', 'subhd.tv', 'subhd.one', 'subhdtw.com', 'subhd.top', 'subhd.cc'];

function isSubhdUrl(url) {
    try {
        const host = new URL(url).hostname;
        return SUBHD_DOMAINS.some(function(d){ return host === d || host.endsWith('.' + d); });
    } catch (_error) {
        return false;
    }
}

// [reason] sub_fetch_* is a generic CORS-free proxy for the content script; keep it from
// being abused to read intranet/localhost resources through the extension's host permissions
function isAllowedFetchUrl(url) {
    try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        const host = u.hostname;
        if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) return false;
        if (host.charAt(0) === '[') return false; // IPv6 literals
        if (/^(127|10|0)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
        return true;
    } catch (_error) {
        return false;
    }
}

function ensureSubhdOriginStripped() {
    if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) {
        return Promise.resolve(); // shortcut: old Firefox without DNR, degrade to current (blocked) behavior
    }
    // [reason] scope to background-initiated requests (no tab, tabId -1): Chrome's
    // initiatorDomains did NOT match service-worker fetches, leaving Origin intact and
    // SubHD 403'ing; tabIds [-1] matches them in both engines and still never touches
    // page-initiated requests
    const condition = {
        requestDomains: SUBHD_DOMAINS,
        resourceTypes: ['xmlhttprequest', 'other'],
        tabIds: [-1]
    };
    return chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [SUBHD_DNR_RULE_ID],
        addRules: [{
            id: SUBHD_DNR_RULE_ID,
            priority: 1,
            action: {
                type: 'modifyHeaders',
                requestHeaders: [
                    { header: 'Origin', operation: 'remove' },
                    { header: 'Sec-Fetch-Site', operation: 'set', value: 'same-origin' }
                ]
            },
            condition: condition
        }]
    }).catch(function(error){
        console.warn('DNR rule install failed:', error);
    });
}

// [reason] Chrome service-worker requests can still trip SubHD's bot checks
// (extension Origin, Sec-Fetch-Site "none"); a real page context passes, so run the
// download handshake inside a temporary hidden tab on the detail page and fetch only
// the final file URL back in the service worker
function subhdPrepareInPage(){
    const sid = location.pathname.split('/').pop();
    const api = function(path, body){
        return fetch(location.origin + path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'application/json'
            },
            body: JSON.stringify(body),
            credentials: 'include'
        }).then(function(r){ return r.text(); }).then(function(text){
            try { return JSON.parse(text); } catch (_error) { return null; }
        });
    };
    return api('/api/sub/prepare-download', { sid: sid }).then(function(prep){
        if (!prep || prep.success !== true || typeof prep.url !== 'string' || prep.url.indexOf('/down/') !== 0) {
            return { ok: false, error: 'prepare: ' + ((prep && (prep.msg || prep.error)) || 'unknown error') };
        }
        // visit the one-time temp page to arm the token (its body is never parsed)
        const downUrl = prep.url.indexOf('http') === 0 ? prep.url : location.origin + prep.url;
        return fetch(downUrl, { credentials: 'include' }).then(function(){
            return api('/api/sub/down', { sid: sid, cap: '' });
        }).then(function(down){
            if (!down || down.success !== true || typeof down.url !== 'string' || !down.url) {
                return { ok: false, error: 'down: ' + ((down && down.msg) || 'unknown error') };
            }
            return { ok: true, fileUrl: down.url.indexOf('http') === 0 ? down.url : location.origin + down.url };
        });
    }).catch(function(error){
        return { ok: false, error: error.message };
    });
}

function waitForTabComplete(tabId, timeoutMs){
    return new Promise(function(resolve, reject){
        let done = false;
        function finish(fn, arg){
            if (done) return;
            done = true;
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            fn(arg);
        }
        const timer = setTimeout(function(){ finish(reject, new Error('tab load timeout')); }, timeoutMs);
        function listener(updatedTabId, info){
            if (updatedTabId === tabId && info.status === 'complete') finish(resolve);
        }
        chrome.tabs.onUpdated.addListener(listener);
        chrome.tabs.get(tabId).then(function(tab){
            if (tab.status === 'complete') finish(resolve);
        }).catch(function(error){ finish(reject, error); });
    });
}

async function subhdPageDownload(itemUrl){
    let tabId = null;
    try {
        const tab = await chrome.tabs.create({ url: itemUrl, active: false });
        tabId = tab.id;
        await waitForTabComplete(tabId, 20000);
        const injections = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: subhdPrepareInPage
        });
        const result = injections && injections[0] && injections[0].result;
        if (!result || result.ok !== true || !result.fileUrl) {
            throw new Error((result && result.error) || 'no result from page script');
        }
        return await subtitleFetch({ url: result.fileUrl, credentials: 'include', want: 'file' });
    } finally {
        if (tabId !== null) {
            chrome.tabs.remove(tabId).catch(function(){ /* tab already gone */ });
        }
    }
}

// transient resets (server RST, CF hiccup) surface as NetworkError in Firefox;
// retry idempotent GETs a couple of times before giving up
async function fetchWithRetries(url, fetchOptions) {
    let lastError;
    const maxAttempts = (fetchOptions.method && fetchOptions.method !== 'GET') ? 1 : 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fetch(url, fetchOptions);
        } catch (error) {
            lastError = error;
            if (attempt < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 400 * attempt));
            }
        }
    }
    throw lastError;
}

async function subtitleFetch(request) {
    if (!isAllowedFetchUrl(request.url)) {
        return { ok: false, error: 'Blocked non-public URL: ' + request.url };
    }
    // Firefox sends "Origin: moz-extension://..." on background fetches just like
    // Chrome (v3 proved removing the rule broke prepare again), so strip it everywhere
    if (isSubhdUrl(request.url)) {
        await ensureSubhdOriginStripped();
    }
    const fetchOptions = {
        method: request.method || 'GET',
        credentials: request.credentials || 'omit'
    };
    if (request.headers) {
        fetchOptions.headers = request.headers;
    }
    if (request.body) {
        fetchOptions.body = request.body;
    }
    if (request.referer) {
        // [reason] "Referer" is a forbidden header name; the referrer option is the only way.
        fetchOptions.referrer = request.referer;
    }

    const response = await fetchWithRetries(request.url, fetchOptions);
    const mime = response.headers.get('content-type') || '';
    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    if (contentLength > SUB_FETCH_MAX_BYTES) {
        return { ok: false, status: response.status, mime, error: 'Response too large (>20MB)' };
    }

    if (request.want === 'text') {
        const text = await response.text();
        if (text.length > SUB_FETCH_MAX_BYTES) {
            return { ok: false, status: response.status, mime, error: 'Response too large (>20MB)' };
        }
        return { ok: response.ok && response.status < 400, status: response.status, mime, text };
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > SUB_FETCH_MAX_BYTES) {
        return { ok: false, status: response.status, mime, error: 'File too large (>20MB)' };
    }
    return {
        ok: response.ok && response.status < 400,
        status: response.status,
        mime,
        base64: binaryToBase64(buffer)
    };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'sub_fetch_text' || message.action === 'sub_fetch_file') {
        subtitleFetch({
            ...message,
            want: message.action === 'sub_fetch_text' ? 'text' : 'file'
        })
            .then(sendResponse)
            .catch(error => sendResponse({
                ok: false,
                error: error.message + ' [' + (message.method || 'GET') + ' ' + (message.url || '?') + ']'
            }));
        return true;
    }
    if (message.action === 'subhd_page_download') {
        subhdPageDownload(message.item)
            .then(sendResponse)
            .catch(error => sendResponse({ ok: false, error: error.message }));
        return true;
    }
});
