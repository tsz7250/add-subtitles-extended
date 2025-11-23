# 新增字幕擴充套件

繁體中文 | [English](README.md)

一個簡單但功能強大的 Firefox 瀏覽器擴充套件，讓您可以為網頁上的任何 `<video>` 元素新增外部字幕檔案。

<img src="./pic/demo.png" alt="示範" height=300>

## 功能特色

- 支援 SRT、VTT、ASS/SSA 字幕格式
- 支援 ZIP 壓縮檔中的字幕
- 自動簡體中文轉繁體中文
- 可調整字幕位置、大小和顏色
- 支援全螢幕播放
- 鍵盤快捷鍵控制

## 第三方函式庫聲明

本擴充套件使用了以下第三方函式庫。完整資訊請參閱 [THIRD_PARTY_LIBRARIES.md](THIRD_PARTY_LIBRARIES.md)：

### JSZip v3.3.0
- **用途**：處理 ZIP 壓縮檔中的字幕檔案
- **來源**：[官方 GitHub 儲存庫](https://github.com/Stuk/jszip)
- **授權條款**：MIT License
- **版本**：3.3.0（穩定版本）

### OpenCC-JS v1.0.5
- **用途**：簡體中文轉繁體中文
- **來源**：[官方 GitHub 儲存庫](https://github.com/nk2028/opencc-js)
- **授權條款**：MIT License
- **版本**：1.0.5（穩定版本）

## 建置說明

本擴充套件包含經過壓縮的第三方函式庫，需要從原始碼重新產生。請依照以下步驟建置擴充套件：

### 先決條件

- 可連接網際網路的現代化網頁瀏覽器
- 基本的檔案下載和放置知識

### 重新產生壓縮檔案

擴充套件在 `content_scripts/` 目錄中包含兩個經過壓縮的第三方函式庫：

#### 1. JSZip v3.3.0 (`jszip.min.js`)

**來源**：[JSZip v3.3.0 GitHub 發行版](https://github.com/Stuk/jszip/releases/tag/v3.3.0)

**重新產生步驟**：
1. 從以下網址下載 zip 檔案：https://github.com/Stuk/jszip/releases/tag/v3.3.0
2. 將 `dist/jszip.min.js` 複製到 `content_scripts/jszip.min.js`

#### 2. OpenCC-JS v1.0.5 (`opencc-cn2t.js`)

**來源**：[OpenCC-JS v1.0.5 GitHub 發行版](https://github.com/nk2028/opencc-js/releases/tag/v1.0.5)

**重新產生步驟**：
1. 從以下網址下載 zip 檔案：https://github.com/nk2028/opencc-js/releases/tag/v1.0.5
5. 將 `src/cn2t.min.js` 複製到 `content_scripts/opencc-cn2t.js`

### 最後驗證

重新產生壓縮檔案後，請驗證擴充套件是否正常運作：

1. 在 Firefox 的開發者模式中載入擴充套件
2. 在具有影片功能的網頁上測試功能
3. 確保所有功能都如預期運作（字幕載入、格式支援、中文轉換）

### 檔案完整性

重新產生的壓縮檔案在功能上應與本儲存庫中的檔案相同。由於建置環境不同，逐位元組的完全一致性可能會有所差異，但功能必須完全相同。

## 安裝方式

1. 從 Firefox 附加元件商店安裝（建議）
2. 或下載 `.xpi` 檔案進行手動安裝

## 使用方法

1. 在包含 `<video>` 元素的網頁上點擊擴充套件圖示
2. 選擇要新增字幕的影片元素
3. 上傳字幕檔案或輸入字幕檔案的網址
4. 調整字幕設定（選用）
5. 享受帶有字幕的影片！

## 授權條款

本專案採用 MIT 授權條款。詳細資訊請參閱 [LICENSE](LICENSE) 檔案。
