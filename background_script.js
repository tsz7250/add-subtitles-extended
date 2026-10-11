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
