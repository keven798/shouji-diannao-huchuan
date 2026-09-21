# 手机电脑互传

手机与电脑之间的文件同步/互传工具（局域网 Web 应用，无需安装 APP）。

- 远程仓库：`git@github.com:keven798/shouji-diannao-huchuan.git`（GitHub 仓库名不支持中文，故用拼音；仓库公开，可自由克隆/下载 ZIP）
- 默认分支：`main`

## 启动

```bash
npm install   # 首次
npm start     # 或双击 启动互传.bat
```

服务监听 `0.0.0.0:5210`，启动时自动检测局域网地址并打印二维码。

## 使用

| 端 | 地址 | 功能 |
|---|---|---|
| 手机 | `http://<电脑局域网IP>:5210/`（电脑端页面有二维码可扫） | 相册多选批量传图（保序）、下载电脑推来的文件 |
| 电脑 | `http://localhost:5210/pc` | 批次管理、命名预览、批量 ZIP 下载 |

### 批量命名（两种方式）

1. **模板命名**：`{seq}` 3位序号 / `{event}` 批次名 / `{date}` / `{time}` / `{name}` 原名 / `{orig}` / `{ext}`，实时预览，重名自动 `-1` 去重
2. **Excel 模板导入**（电脑端）：两列「序号、名称」，第 1 列为上传序号、第 2 列为目标名称（自动补扩展名）；未命中的序号回退模板命名。可点「下载模板」按当前批次生成

## 技术栈

Node.js + Express + multer + archiver + qrcode + SheetJS(xlsx)，零数据库，文件落盘 `data/uploads/<批次>/manifest.json`。
