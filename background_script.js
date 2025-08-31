// Function to inject all content scripts
async function injectContentScripts(tabId) {
    console.log('Starting content script injection for tab:', tabId);
    
    try {
        // First inject JSZip (smaller, more reliable)
        console.log('Injecting JSZip...');
        await browser.tabs.executeScript(tabId, {
            file: "/content_scripts/jszip.min.js"
        });
        console.log('JSZip injected successfully');
        
        // Try direct executeScript injection first
        console.log('Method 0: Attempting direct executeScript injection...');
        try {
            const directResult = await browser.tabs.executeScript(tabId, {
                file: "/content_scripts/opencc-cn2t.js"
            });
            console.log('Direct executeScript result:', directResult);
            
            // Force global assignment if UMD didn't work properly
            await browser.tabs.executeScript(tabId, {
                code: `
                    console.log('=== Post-ExecuteScript Global Assignment ===');
                    console.log('window.OpenCC exists:', typeof window.OpenCC !== 'undefined');
                    console.log('globalThis.OpenCC exists:', typeof globalThis.OpenCC !== 'undefined');
                    console.log('self.OpenCC exists:', typeof self.OpenCC !== 'undefined');
                    
                    // If OpenCC exists on globalThis but not window, copy it
                    if (typeof window.OpenCC === 'undefined' && typeof globalThis.OpenCC !== 'undefined') {
                        console.log('Found OpenCC on globalThis, copying to window...');
                        window.OpenCC = globalThis.OpenCC;
                    }
                    
                    // If OpenCC exists on self but not window, copy it
                    if (typeof window.OpenCC === 'undefined' && typeof self.OpenCC !== 'undefined') {
                        console.log('Found OpenCC on self, copying to window...');
                        window.OpenCC = self.OpenCC;
                    }
                    
                    // Re-execute the UMD factory if needed
                    if (typeof window.OpenCC === 'undefined') {
                        console.log('OpenCC still not found, attempting manual UMD execution...');
                        try {
                            // Create a minimal global context for UMD
                            const umdGlobal = window;
                            umdGlobal.OpenCC = {};
                            
                            // The UMD should have created exports, try to find them
                            console.log('Checking for OpenCC exports in various locations...');
                            const possibleLocations = [
                                'window.exports',
                                'globalThis.exports', 
                                'self.exports'
                            ];
                            
                            for (const location of possibleLocations) {
                                try {
                                    const exports = eval(location);
                                    if (exports && exports.Converter) {
                                        console.log('Found OpenCC exports at:', location);
                                        window.OpenCC = exports;
                                        break;
                                    }
                                } catch (e) {
                                    // Location doesn't exist
                                }
                            }
                        } catch (manualError) {
                            console.error('Manual UMD execution failed:', manualError);
                        }
                    }
                    
                    'global_assignment_completed';
                `
            });
            
            // Check if OpenCC is now available
            const checkResult = await browser.tabs.executeScript(tabId, {
                code: `
                    console.log('=== Final Direct ExecuteScript Check ===');
                    console.log('window.OpenCC exists:', typeof window.OpenCC !== 'undefined');
                    if (typeof window.OpenCC !== 'undefined') {
                        console.log('window.OpenCC:', window.OpenCC);
                        console.log('OpenCC.Converter type:', typeof window.OpenCC.Converter);
                        if (window.OpenCC.Converter) {
                            try {
                                const directConverter = window.OpenCC.Converter({ from: 'cn', to: 'tw' });
                                const directResult = directConverter('直接测试');
                                console.log('Direct conversion test: "直接测试" ->', directResult);
                                (directResult !== '直接测试') ? 'direct_success' : 'direct_no_conversion';
                            } catch (directTestError) {
                                console.error('Direct test failed:', directTestError);
                                'direct_test_failed';
                            }
                        } else {
                            'direct_no_converter';
                        }
                    } else {
                        'direct_no_opencc';
                    }
                `
            });
            
            console.log('Direct executeScript check result:', checkResult[0]);
            if (checkResult[0] === 'direct_success') {
                await browser.tabs.executeScript(tabId, { 
                    code: `window._openccLoadResult = 'direct_execute_success';` 
                });
                console.log('SUCCESS: Direct executeScript worked');
                // Do not return here; continue to inject the main script/UI
            } else {
                console.log('Direct executeScript did not work, result:', checkResult[0]);
                await browser.tabs.executeScript(tabId, { 
                    code: `window._openccLoadResult = '${checkResult[0]}';` 
                });
            }
        } catch (directError) {
            console.error('Direct executeScript failed:', directError);
            await browser.tabs.executeScript(tabId, { 
                code: `window._openccLoadResult = 'direct_execute_failed';` 
            });
        }
        
        // Skip dynamic loading for now, focus on making executeScript work
        // Finally inject the main script
        console.log('Injecting main add_subtitles script...');
        await browser.tabs.executeScript(tabId, {
            file: "/content_scripts/add_subtitles.js"
        });
        console.log('Main script injected successfully');
    console.log('All content scripts injection completed');
        
    } catch (error) {
        console.error('Content script injection failed:', error);
        throw error;
    }
}

// Browser action button handler
browser.browserAction.onClicked.addListener(async function(tab) {
    console.log('Button clicked for tab:', tab.id);
    console.log('Tab URL:', tab.url);
    
    // Inject content scripts into the active tab
    await injectContentScripts(tab.id);
});

// Message listener for re-injection requests
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Received message:', message);
    
    if (message.action === 'reinject_opencc' && sender.tab && sender.tab.id) {
        console.log('Re-injection request from tab:', sender.tab.id);
        
        // Re-inject scripts in the requesting tab
        injectContentScripts(sender.tab.id)
            .then(() => {
                console.log('Re-injection completed');
                sendResponse({ success: true, message: 'Scripts re-injected' });
            })
            .catch(error => {
                console.error('Re-injection failed:', error);
                sendResponse({ success: false, error: error.message });
            });
        
        // Return true to indicate we'll send a response asynchronously
        return true;
    }
});