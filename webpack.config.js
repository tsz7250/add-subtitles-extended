const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

// [reason] libarchive.js resolves its wasm via `new URL("libarchive.wasm", import.meta.url)`,
// which breaks when the worker is spawned from a blob URL (content scripts cannot
// construct cross-origin workers from extension URLs). Patch the bundle to prefer
// an absolute URL injected by the content script via `self.__libarchiveWasmUrl`.
// String is from libarchive.js 2.0.2 dist; re-check after upgrading the package.
const WASM_URL_TARGET = 'N=new URL("libarchive.wasm",import.meta.url).href';
const WASM_URL_PATCHED = 'N=self.__libarchiveWasmUrl||new URL("libarchive.wasm",import.meta.url).href';

module.exports = {
    mode: 'production',
    devtool: false,
    target: 'web',
    entry: {
        'background_script': './src/background_script.js',
        'content_scripts/add_subtitles': './src/content_scripts/add_subtitles.js',
        'content_scripts/context_menu_guard': './src/content_scripts/context_menu_guard.js',
    },
    output: {
        path: path.resolve(__dirname, 'build'),
        filename: '[name].js',
        clean: true,
    },
    optimization: {
        splitChunks: false,
        runtimeChunk: false,
    },
    plugins: [
        new CopyPlugin({
            patterns: [
                {
                    from: 'node_modules/libarchive.js/dist/worker-bundle.js',
                    to: 'libarchive/worker-bundle.js',
                    transform(content) {
                        const patched = content.toString('utf8').split(WASM_URL_TARGET).join(WASM_URL_PATCHED);
                        if (!patched.includes(WASM_URL_PATCHED)) {
                            throw new Error('libarchive worker-bundle.js wasm URL patch did not apply — bundle format changed.');
                        }
                        return Buffer.from(patched, 'utf8');
                    },
                },
                {
                    from: 'node_modules/libarchive.js/dist/libarchive.wasm',
                    to: 'libarchive/libarchive.wasm',
                },
            ],
        }),
    ],
};
