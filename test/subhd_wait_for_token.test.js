const test = require('node:test');
const assert = require('node:assert/strict');
const subhdWaitForToken = require('../src/subhd_wait_for_token');

function installFakeDom() {
    const previousDocument = global.document;
    const previousMutationObserver = global.MutationObserver;
    let widgetPresent = false;
    let challengeReady = false;
    let token = '';
    let mutationCallback = null;
    let disconnected = false;

    const widgetContainer = {
        querySelector(selector) {
            if (selector === 'input[name="cf-turnstile-response"]') {
                return challengeReady ? { value: token } : null;
            }
            if (selector === 'iframe, input[name="cf-turnstile-response"]') {
                return challengeReady ? {} : null;
            }
            return null;
        }
    };

    global.document = {
        documentElement: {},
        querySelector(selector) {
            return selector === '.download-turnstile-widget' && widgetPresent
                ? widgetContainer
                : null;
        }
    };
    global.MutationObserver = class {
        constructor(callback) {
            mutationCallback = callback;
        }
        observe() {}
        disconnect() {
            disconnected = true;
        }
    };

    return {
        setWidgetPresent(value) {
            widgetPresent = value;
            if (mutationCallback) mutationCallback();
        },
        setChallengeReady(value) {
            challengeReady = value;
            if (mutationCallback) mutationCallback();
        },
        setToken(value) {
            token = value;
            if (mutationCallback) mutationCallback();
        },
        wasDisconnected() {
            return disconnected;
        },
        restore() {
            global.document = previousDocument;
            global.MutationObserver = previousMutationObserver;
        }
    };
}

test('waits for a delayed widget and token', { concurrency: false }, async () => {
    const fakeDom = installFakeDom();
    try {
        const waiting = subhdWaitForToken(100);
        fakeDom.setWidgetPresent(true);
        fakeDom.setChallengeReady(true);
        fakeDom.setToken('token-value');
        assert.deepEqual(await waiting, { ok: true, token: 'token-value' });
        assert.equal(fakeDom.wasDisconnected(), true);
    } finally {
        fakeDom.restore();
    }
});

test('waits for a token in an existing widget', { concurrency: false }, async () => {
    const fakeDom = installFakeDom();
    try {
        fakeDom.setWidgetPresent(true);
        fakeDom.setChallengeReady(true);
        const waiting = subhdWaitForToken(100);
        fakeDom.setToken('later-token');
        assert.deepEqual(await waiting, { ok: true, token: 'later-token' });
    } finally {
        fakeDom.restore();
    }
});

test('reports a ready challenge when its token times out', { concurrency: false }, async () => {
    const fakeDom = installFakeDom();
    try {
        fakeDom.setWidgetPresent(true);
        fakeDom.setChallengeReady(true);
        assert.deepEqual(await subhdWaitForToken(10), {
            ok: false,
            challengeReady: true,
            error: 'turnstile: token timeout'
        });
    } finally {
        fakeDom.restore();
    }
});

test('does not request foreground focus when the widget never loads', { concurrency: false }, async () => {
    const fakeDom = installFakeDom();
    try {
        assert.deepEqual(await subhdWaitForToken(10), {
            ok: false,
            challengeReady: false,
            error: 'turnstile: widget failed to load'
        });
    } finally {
        fakeDom.restore();
    }
});
