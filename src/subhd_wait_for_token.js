function subhdWaitForToken(timeoutMs) {
    const documentRoot = document.documentElement;
    if (!documentRoot) {
        return Promise.resolve({ ok: false, challengeReady: false, error: 'turnstile: document unavailable' });
    }

    const readChallengeState = function() {
        const widgetContainer = document.querySelector('.download-turnstile-widget');
        const responseInput = widgetContainer
            ? widgetContainer.querySelector('input[name="cf-turnstile-response"]')
            : null;
        return {
            token: responseInput && responseInput.value ? responseInput.value : '',
            challengeReady: !!(widgetContainer && widgetContainer.querySelector('iframe, input[name="cf-turnstile-response"]'))
        };
    };

    const initialState = readChallengeState();
    if (initialState.token) {
        return Promise.resolve({ ok: true, token: initialState.token });
    }
    if (document.querySelector('.download-expired-page')) {
        return Promise.resolve({
            ok: false,
            challengeReady: false,
            error: 'turnstile: download page expired'
        });
    }

    return new Promise(function(resolve) {
        let done = false;
        const finish = function(result) {
            if (done) return;
            done = true;
            observer.disconnect();
            clearInterval(pollTimer);
            clearTimeout(timeoutTimer);
            resolve(result);
        };
        const checkForToken = function() {
            const state = readChallengeState();
            if (state.token) finish({ ok: true, token: state.token });
        };
        const observer = new MutationObserver(checkForToken);
        observer.observe(documentRoot, { childList: true, subtree: true, attributes: true });
        const pollTimer = setInterval(checkForToken, 250);
        const timeoutTimer = setTimeout(function() {
            const state = readChallengeState();
            finish({
                ok: false,
                challengeReady: state.challengeReady,
                error: state.challengeReady
                    ? 'turnstile: token timeout'
                    : 'turnstile: widget failed to load'
            });
        }, timeoutMs);
        checkForToken();
    });
}

module.exports = subhdWaitForToken;
