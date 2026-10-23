# OpenApi

按系统整理 HTTP 接口。一个系统下面是按「方法 + 路径」归好的接口，每条用例是一个独立的文本代码框。

设计见 [docs/设计.md](docs/设计.md)。

## 开发

```bash
npm install
npm run tauri dev
```

## 打包

```bash
npm run tauri build
```

同一套 Rust + Tauri 2 代码可以打成 macOS、Windows、Linux 桌面应用。

## 数据

记录在本机应用数据目录的 `library.db`，不上传。导入按钮选择原来的 Markdown 目录即可。
