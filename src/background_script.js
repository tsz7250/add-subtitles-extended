// [reason] chrome.* with callbacks works in both Chrome and Firefox WebExtensions.
const subhdWaitForToken = require('./subhd_wait_for_token');
const { SUBHD_HOSTS, subhdDnrRegexFilter } = require('./subhd_config');

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
            const failed = results.find(result => result.error);
            if (failed) {
                reject(new Error(failed.error.message || String(failed.error)));
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
    await ensureFetchPermissions();
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

// [reason] Firefox MV3 treats declared host_permissions as opt-in; without the grant
// background fetches hit CORS (status 200 but response unreadable). The action button
// click is a user gesture, so we ask for the API origins there.
const FETCH_ORIGINS = SUBHD_HOSTS.map(function(d){ return '*://*.' + d + '/*'; })
    .concat(['*://api.assrt.net/*', '*://api.opensubtitles.com/*']);

function ensureFetchPermissions() {
    return new Promise(function(resolve){
        chrome.permissions.contains({ origins: FETCH_ORIGINS }, function(has){
            if (has || chrome.runtime.lastError) {
                resolve();
                return;
            }
            chrome.permissions.request({ origins: FETCH_ORIGINS }, function(){ resolve(); });
        });
    });
}

function isSubhdUrl(url) {
    try {
        const host = new URL(url).hostname;
        return SUBHD_HOSTS.some(function(d){ return host === d || host.endsWith('.' + d); });
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
    // page-initiated requests. regexFilter limits it to the download API paths — the
    // only requests that ever needed this fix; plain GETs (search) go out untouched.
    const condition = {
        regexFilter: subhdDnrRegexFilter(),
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

function waitForTabComplete(tabId, timeoutMs){
    return new Promise(function(resolve, reject){
        let done = false;
        function finish(fn, arg){
            if (done) return;
            done = true;
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            chrome.tabs.onRemoved.removeListener(removedListener);
            fn(arg);
        }
        const timer = setTimeout(function(){ finish(reject, new Error('tab load timeout')); }, timeoutMs);
        function listener(updatedTabId, info){
            if (updatedTabId === tabId && info.status === 'complete') finish(resolve);
        }
        function removedListener(removedTabId){
            if (removedTabId === tabId) finish(reject, new Error('download tab was closed'));
        }
        chrome.tabs.onUpdated.addListener(listener);
        chrome.tabs.onRemoved.addListener(removedListener);
        chrome.tabs.get(tabId).then(function(tab){
            if (tab.status === 'complete') finish(resolve);
        }).catch(function(error){ finish(reject, error); });
    });
}

// [reason] injected into the /down/ tab, so it must be self-contained (no outer refs)
async function subhdDownRequest(subtitleId, turnstileToken){
    const response = await fetch('/api/sub/down', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: subtitleId, turnstileToken: turnstileToken }),
        credentials: 'include'
    });
    let json = null;
    try { json = await response.json(); } catch (_error) {}
    return { status: response.status, json: json };
}

// [reason] the Turnstile token can only be minted in a real page on /down/<sid>;
// prepare-download still works from the service worker (DNR rules strip Origin /
// Sec-Fetch-Site), so token creation runs inside a temporary background tab
async function subhdPageDownload(itemUrl){
    const sid = (itemUrl || '').split('/').pop();
    const origin = new URL(itemUrl).origin;
    let tabId = null;
    try {
        const tab = await chrome.tabs.create({ url: itemUrl, active: false });
        tabId = tab.id;
        await waitForTabComplete(tabId, 20000);
        // [reason] Firefox partitions extension and first-party cookies. Prepare inside
        // the detail page so the temporary /down/ state belongs to the tab that uses it.
        const prepResults = await executeScript(tabId, {
            func: async function(subtitleId){
                const response = await fetch('/api/sub/prepare-download', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json; charset=utf-8',
                        'X-Requested-With': 'XMLHttpRequest',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify({ sid: subtitleId }),
                    credentials: 'include'
                });
                let json = null;
                try { json = await response.json(); } catch (_error) {}
                return { status: response.status, json: json };
            },
            args: [sid]
        });
        const prep = prepResults && prepResults[0];
        const prepJson = prep && prep.json;
        if (!prepJson || prepJson.success !== true || typeof prepJson.url !== 'string' || prepJson.url.indexOf('/down/') !== 0) {
            throw new Error('prepare: ' + ((prepJson && prepJson.msg) || ('HTTP ' + ((prep && prep.status) || '?'))));
        }
        await chrome.tabs.update(tabId, { url: origin + prepJson.url });
        await waitForTabComplete(tabId, 20000);
        // [reason] SubHD does not render Turnstile until the first tokenless down
        // request says it is required. Probe first so no-challenge downloads skip it.
        let downResults = await executeScript(tabId, {
            func: subhdDownRequest,
            args: [sid, '']
        });
        let api = downResults && downResults[0];
        let down = api && api.json;
        if (down && down.turnstileRequired) {
            // Run the site's click handler; it reveals the box and renders Turnstile.
            const clicked = await executeScript(tabId, {
                func: function(){
                    const button = document.querySelector('.download-submit, .down');
                    if (!button) return false;
                    button.click();
                    return true;
                }
            });
            if (!clicked || clicked[0] !== true) {
                throw new Error('turnstile: download button not found');
            }
            let token = '';
            for (let attempt = 0; attempt < 2; attempt++) {
                if (attempt > 0) {
                    // [reason] Turnstile may require an interactive challenge.
                    await chrome.tabs.update(tabId, { active: true }).catch(function(){});
                }
                const results = await executeScript(tabId, {
                    func: subhdWaitForToken,
                    args: [attempt === 0 ? 15000 : 90000]
                });
                const result = results && results[0];
                if (result && result.ok === true && result.token) {
                    token = result.token;
                    break;
                }
                if (!result || !result.challengeReady) {
                    throw new Error((result && result.error) || 'no result from page script');
                }
            }
            if (!token) throw new Error('turnstile: token timeout');
            downResults = await executeScript(tabId, {
                func: subhdDownRequest,
                args: [sid, token]
            });
            api = downResults && downResults[0];
            down = api && api.json;
        }
        if (down && down.dailyLimitReached) {
            throw new Error('down: ' + (down.msg || 'daily download limit reached'));
        }
        if (!down || down.success !== true || down.pass !== true || typeof down.url !== 'string' || !down.url) {
            throw new Error('down: ' + ((down && down.msg) || ('HTTP ' + ((api && api.status) || '?'))));
        }
        const fileUrl = down.url.indexOf('http') === 0 ? down.url : origin + down.url;
        const file = await subtitleFetch({ url: fileUrl, credentials: 'include', want: 'file' });
        if (!file.ok || !file.base64) {
            throw new Error('file: ' + (file.error || ('HTTP ' + file.status)));
        }
        return file;
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
