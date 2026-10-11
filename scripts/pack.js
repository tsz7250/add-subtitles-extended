const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
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

function compressDirectory(sourceDir, archivePath) {
    if (process.platform === 'win32') {
        const escapedSource = sourceDir.replace(/'/g, "''");
        const escapedArchive = archivePath.replace(/'/g, "''");
        const command = `Compress-Archive -Path '${escapedSource}\\*' -DestinationPath '${escapedArchive}' -Force`;
        execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { stdio: 'inherit' });
        return;
    }

    execSync(`cd ${JSON.stringify(sourceDir)} && zip -qr ${JSON.stringify(archivePath)} .`, {
        stdio: 'inherit'
    });
}

function buildPackage(browser) {
    const outputDir = path.join(distDir, browser);
    const archivePath = path.join(packagesDir, `add-subtitles-extended-${browser}.zip`);

    removeIfExists(outputDir);
    fs.mkdirSync(outputDir, { recursive: true });
    commonFiles.forEach((entryName) => copyEntry(entryName, outputDir));
    writeManifest(browser, outputDir);
    removeIfExists(archivePath);
    compressDirectory(outputDir, archivePath);

    console.log(`Created ${archivePath}`);
}

try {
    removeIfExists(distDir);
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.mkdirSync(packagesDir, { recursive: true });
    buildPackage('chrome');
    buildPackage('firefox');
    removeIfExists(stagingDir);
    console.log('Build completed.');
} catch (error) {
    removeIfExists(stagingDir);
    console.error(`Build failed: ${error.message}`);
    process.exitCode = 1;
}
