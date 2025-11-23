# Add Subtitles Extension

[繁體中文](README.zh-TW.md) | English

A simple yet powerful Firefox browser extension that allows you to add external subtitle files to any `<video>` element on web pages.

<img src="./pic/demo.png" alt="Demo" height=300>

## Features

- Support for SRT, VTT, ASS/SSA subtitle formats
- Support for subtitles in ZIP archives
- Automatic Simplified to Traditional Chinese conversion
- Adjustable subtitle position, size, and color
- Full-screen playback support
- Keyboard shortcut controls

## Third-Party Libraries Declaration

This extension uses the following third-party libraries. For complete information, please refer to [THIRD_PARTY_LIBRARIES.md](THIRD_PARTY_LIBRARIES.md):

### JSZip v3.3.0
- **Purpose**: Handle subtitle files in ZIP archives
- **Source**: [Official GitHub Repository](https://github.com/Stuk/jszip)
- **License**: MIT License
- **Version**: 3.3.0 (stable version)

### OpenCC-JS v1.0.5
- **Purpose**: Simplified Chinese to Traditional Chinese conversion
- **Source**: [Official GitHub Repository](https://github.com/nk2028/opencc-js)
- **License**: MIT License  
- **Version**: 1.0.5 (stable version)

## Build Instructions

This extension contains minified third-party libraries that need to be reproduced from their source code. Follow these steps to build the extension:

### Prerequisites

- A modern web browser with internet access
- Basic knowledge of downloading and placing files

### Reproducing Minified Files

The extension contains two minified third-party libraries in the `content_scripts/` directory:

#### 1. JSZip v3.3.0 (`jszip.min.js`)

**Source**: [JSZip v3.3.0 GitHub Release](https://github.com/Stuk/jszip/releases/tag/v3.3.0)

**Steps to reproduce**:
1. Download the zip file from: https://github.com/Stuk/jszip/releases/tag/v3.3.0
2. Copy `dist/jszip.min.js` to `content_scripts/jszip.min.js`

#### 2. OpenCC-JS v1.0.5 (`opencc-cn2t.js`)

**Source**: [OpenCC-JS v1.0.5 GitHub Release](https://github.com/nk2028/opencc-js/releases/tag/v1.0.5)

**Steps to reproduce**:
1. Download the zip file from: https://github.com/nk2028/opencc-js/releases/tag/v1.0.5
5. Copy `src/cn2t.min.js` to `content_scripts/opencc-cn2t.js`

### Final Verification

After reproducing the minified files, verify that the extension works correctly:

1. Load the extension in Firefox's developer mode
2. Test the functionality on a video-enabled webpage
3. Ensure all features work as expected (subtitle loading, format support, Chinese conversion)

### File Integrity

The reproduced minified files should be functionally identical to the ones in this repository. The exact byte-for-byte match may vary due to different build environments, but the functionality must be identical.

## Installation

1. Install from Firefox Add-ons Store (recommended)
2. Or download the `.xpi` file for manual installation

## Usage

1. Click the extension icon on web pages with `<video>` elements
2. Select the video element to add subtitles to
3. Upload subtitle files or enter the URL of subtitle files
4. Adjust subtitle settings (optional)
5. Enjoy videos with subtitles!

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.