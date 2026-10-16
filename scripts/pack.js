const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const JSZip = require(path.join(rootDir, 'content_scripts', 'jszip.min.js'));
const distDir = path.join(rootDir, 'dist');
const stagingDir = path.join(distDir, '.staging');
const packagesDir = path.join(distDir, 'packages');

const commonFiles = [
    'assets',
    'content_scripts',
    'background_script.js',
    'LICENSE',
    'README.md',
    'THIRD_PARTY_LIBRARIES.md'
];

function removeIfExists(targetPath) {
    fs.rmSync(targetPath, { recursive: true, force: true });
}

function copyEntry(entryName, destinationDir) {
    const sourcePath = path.join(rootDir, entryName);
    const destinationPath = path.join(destinationDir, entryName);

    if (!fs.existsSync(sourcePath)) {
        throw new Error(`Required package entry does not exist: ${entryName}`);
    }

    fs.cpSync(sourcePath, destinationPath, { recursive: true });
}

function writeManifest(browser, destinationDir) {
    const sourceName = browser === 'firefox' ? 'manifest.firefox.json' : 'manifest.json';
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, sourceName), 'utf8'));
    fs.writeFileSync(
        path.join(destinationDir, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8'
    );
}

function addDirectoryToZip(zip, dirPath, relativePath = '') {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            addDirectoryToZip(zip, fullPath, entryRelativePath);
        } else {
            zip.file(entryRelativePath, fs.readFileSync(fullPath));
        }
    }
}

async function compressDirectory(sourceDir, archivePath) {
    const zip = new JSZip();
    addDirectoryToZip(zip, sourceDir);
    const content = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 }
    });
    fs.writeFileSync(archivePath, content);
}

async function buildPackage(browser) {
    const outputDir = path.join(distDir, browser);
    const archivePath = path.join(packagesDir, `add-subtitles-extended-${browser}.zip`);

    removeIfExists(outputDir);
    fs.mkdirSync(outputDir, { recursive: true });
    commonFiles.forEach((entryName) => copyEntry(entryName, outputDir));
    writeManifest(browser, outputDir);
    removeIfExists(archivePath);
    await compressDirectory(outputDir, archivePath);

    console.log(`Created ${archivePath}`);
}

async function main() {
    try {
        removeIfExists(distDir);
        fs.mkdirSync(stagingDir, { recursive: true });
        fs.mkdirSync(packagesDir, { recursive: true });
        await buildPackage('chrome');
        await buildPackage('firefox');
        removeIfExists(stagingDir);
        console.log('Build completed.');
    } catch (error) {
        removeIfExists(stagingDir);
        console.error(`Build failed: ${error.message}`);
        process.exitCode = 1;
    }
}

main();
