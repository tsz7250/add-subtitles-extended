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

function assignOpenCCGlobal() {
    console.log('=== Post-ExecuteScript Global Assignment ===');
    if (typeof window.OpenCC === 'undefined' && typeof globalThis.OpenCC !== 'undefined') {
        window.OpenCC = globalThis.OpenCC;
    }
    if (typeof window.OpenCC === 'undefined' && typeof self.OpenCC !== 'undefined') {
        window.OpenCC = self.OpenCC;
    }
    if (typeof window.OpenCC === 'undefined') {
        const possibleExports = [window.exports, globalThis.exports, self.exports];
        for (const exportsObject of possibleExports) {
            if (exportsObject && exportsObject.Converter) {
                window.OpenCC = exportsObject;
                break;
            }
        }
    }
    return 'global_assignment_completed';
}

function checkOpenCC() {
    console.log('=== Final Direct ExecuteScript Check ===');
    if (typeof window.OpenCC === 'undefined') return 'direct_no_opencc';
    if (!window.OpenCC.Converter) return 'direct_no_converter';
    try {
        const converter = window.OpenCC.Converter({ from: 'cn', to: 'tw' });
        return converter('直接测试') !== '直接测试' ? 'direct_success' : 'direct_no_conversion';
    } catch (error) {
        console.error('Direct test failed:', error);
        return 'direct_test_failed';
    }
}

function setOpenCCLoadResult(result) {
    window._openccLoadResult = result;
}

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
    console.log('Starting content script injection for tab:', tabId);

    try {
        console.log('Injecting JSZip...');
        await executeScript(tabId, { files: ["content_scripts/jszip.min.js"] });
        console.log('JSZip injected successfully');

        console.log('Method 0: Attempting direct executeScript injection...');
        try {
            const directResult = await executeScript(tabId, {
                files: ["content_scripts/opencc-cn2t.js"]
            });
            console.log('Direct executeScript result:', directResult);

            await executeScript(tabId, { func: assignOpenCCGlobal });
            const checkResult = await executeScript(tabId, { func: checkOpenCC });

            console.log('Direct executeScript check result:', checkResult[0]);
            if (checkResult[0] === 'direct_success') {
                await executeScript(tabId, {
                    func: setOpenCCLoadResult,
                    args: ['direct_execute_success']
                });
                console.log('SUCCESS: Direct executeScript worked');
            } else {
                console.log('Direct executeScript did not work, result:', checkResult[0]);
                await executeScript(tabId, {
                    func: setOpenCCLoadResult,
                    args: [checkResult[0]]
                });
            }
        } catch (directError) {
            console.error('Direct executeScript failed:', directError);
            await executeScript(tabId, {
                func: setOpenCCLoadResult,
                args: ['direct_execute_failed']
            });
        }

        console.log('Injecting main add_subtitles script...');
        await executeScript(tabId, {
            files: ["content_scripts/add_subtitles.js"]
        });
        console.log('Main script injected successfully');
        console.log('All content scripts injection completed');
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

// SubHD's /api/sub/prepare-download rejects extension-origin POSTs
// ("无法准备下载，请返回字幕详情页重试"). Origin is a forbidden header for fetch,
// so strip it via a declarativeNetRequest session rule scoped to our own requests.
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
    const condition = {
        requestDomains: SUBHD_DOMAINS,
        resourceTypes: ['xmlhttprequest', 'other']
    };
    // Chrome extension IDs are 32-char a-p strings (valid DNR "domain"); Firefox IDs are
    // often @-forms that DNR rejects as initiatorDomains, so scope to them only when valid
    if (/^[a-p]{32}$/.test(chrome.runtime.id)) {
        condition.initiatorDomains = [chrome.runtime.id];
    } else {
        // [reason] Firefox @-form ids are rejected by initiatorDomains; scope to
        // background-initiated requests instead (they run without a tab, tabId -1)
        condition.tabIds = [-1];
    }
    return chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [SUBHD_DNR_RULE_ID],
        addRules: [{
            id: SUBHD_DNR_RULE_ID,
            priority: 1,
            action: {
                type: 'modifyHeaders',
                requestHeaders: [{ header: 'Origin', operation: 'remove' }]
            },
            condition: condition
        }]
    }).catch(function(error){
        console.warn('DNR rule install failed:', error);
    });
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
});
