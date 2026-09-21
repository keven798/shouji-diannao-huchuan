/**
 * 手机↔电脑局域网互传 - 服务端
 *
 * API 一览：
 *   POST /api/upload          批量上传（multipart：sessionName / direction / files[]，files 顺序即保留顺序）
 *   GET  /api/sessions        会话列表（含文件数、总大小）
 *   GET  /api/sessions/:id    会话详情（文件按上传顺序 seq 排序）
 *   GET  /api/file/:id/:seq   单文件流（默认 attachment 下载；?inline=1 内联预览，供缩略图）
 *   GET  /api/download/:id    整批打包 ZIP（?template= 命名模板，ZIP 内按模板重命名）
 *   POST /api/download/:id    同上 + Excel 映射：body {template, names:{"序号":"名称"}}
 *   GET  /api/info            自动检测的局域网访问地址
 *   GET  /api/qr              二维码 SVG（?text= 自定义，默认手机端地址）
 *
 * 运行：node server.js   监听 0.0.0.0:5210，启动时打印局域网访问地址与二维码
 */

'use strict';

const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');

const PORT = 5210;
const HOST = '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const PUBLIC_DIR = path.join(ROOT, 'public');

const DEFAULT_TEMPLATE = '{event}_{seq}{ext}';
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 单文件上限 500MB
const MAX_FILES = 500;                   // 单次上传文件数上限

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

/** Windows 非法文件名字符（含路径分隔符）替换为下划线 */
function sanitizeName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 修复 busboy 按 latin1 解析导致的中文文件名乱码：
 * 若文件名仅含 Latin-1 补充区字符（U+0080~U+00FF），视为 UTF-8 字节被误读，做一次还原。
 */
function fixFilename(name) {
  const n = String(name || '');
  const looksLatin1 = /[\u0080-\u00FF]/.test(n) && !/[^\u0000-\u00FF]/.test(n);
  if (!looksLatin1) return n;
  try {
    const fixed = Buffer.from(n, 'latin1').toString('utf8');
    if (fixed && !fixed.includes('\uFFFD')) return fixed;
  } catch (_) { /* 解码失败保留原名 */ }
  return n;
}

/** RFC 5987 Content-Disposition（支持中文文件名） */
function contentDisposition(filename, type = 'attachment') {
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function pad(n, width) {
  return String(n).padStart(width, '0');
}

/** 本地时间 YYYYMMDD / HHmmss */
function fmtDate(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}`;
}
function fmtTime(d) {
  return `${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}${pad(d.getSeconds(), 2)}`;
}

/**
 * 渲染命名模板。可用字段：
 *   {seq} 3位补零序号  {name} 原文件名去扩展名  {ext} 含点小写扩展名
 *   {date} YYYYMMDD    {time} HHmmss          {event} 批次名  {orig} 原始完整文件名
 * 模板为空回退默认；渲染结果为空回退默认；模板未包含 {ext} 时自动补扩展名。
 */
function renderTemplate(tpl, ctx) {
  let t = String(tpl || '').trim() || DEFAULT_TEMPLATE;
  let out = t.replace(/\{(seq|name|ext|date|time|event|orig)\}/g, (_, k) => ctx[k] ?? '');
  out = sanitizeName(out);
  if (!out) out = `${sanitizeName(ctx.event)}_${ctx.seq}${ctx.ext}`;
  if (ctx.ext && !out.toLowerCase().endsWith(ctx.ext)) out += ctx.ext;
  return out;
}

/** ZIP 内重名去重：第二次出现追加 -1，第三次 -2，以此类推 */
function makeDedupe() {
  const used = new Set();
  return function dedupe(name) {
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    const m = name.match(/^(.*?)(\.[^.]+)?$/);
    const base = m ? m[1] : name;
    const ext = m && m[2] ? m[2] : '';
    let i = 1;
    while (used.has(`${base}-${i}${ext}`)) i += 1;
    const finalName = `${base}-${i}${ext}`;
    used.add(finalName);
    return finalName;
  };
}

/* ------------------------------------------------------------------ */
/* 会话存储（data/uploads/<sessionId>/manifest.json）                   */
/* ------------------------------------------------------------------ */

async function ensureDirs() {
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
}

function sessionDir(id) {
  return path.join(UPLOAD_DIR, id);
}

async function readManifest(id) {
  const raw = await fsp.readFile(path.join(sessionDir(id), 'manifest.json'), 'utf8');
  const manifest = JSON.parse(raw);
  manifest.files = (manifest.files || []).slice().sort((a, b) => a.seq - b.seq);
  return manifest;
}

async function writeManifest(manifest) {
  const file = path.join(sessionDir(manifest.id), 'manifest.json');
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function listSessions() {
  let entries = [];
  try {
    entries = await fsp.readdir(UPLOAD_DIR, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const sessions = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    try {
      const m = await readManifest(ent.name);
      sessions.push({
        id: m.id,
        name: m.name,
        direction: m.direction,
        createdAt: m.createdAt,
        fileCount: m.files.length,
        totalSize: m.files.reduce((sum, f) => sum + (Number(f.size) || 0), 0)
      });
    } catch (_) { /* 跳过损坏的会话目录 */ }
  }
  sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return sessions;
}

/* ------------------------------------------------------------------ */
/* Express 应用                                                        */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');

// multer：先落盘到 data/tmp，之后由业务代码移入会话目录并加 seq 前缀
const tmpStorage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, TMP_DIR),
  filename: (_, file, cb) => {
    const safe = sanitizeName(fixFilename(file.originalname)) || 'file';
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safe}`);
  }
});
const upload = multer({
  storage: tmpStorage,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES }
});

/** 创建或追加会话，把上传的临时文件按 seq 顺序归位 */
async function saveUpload(sessionName, direction, tmpFiles) {
  const existing = tmpFiles.sessionId ? await findSession(tmpFiles.sessionId) : null;
  const id = existing ? existing.id : `s_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const dir = sessionDir(id);
  await fsp.mkdir(dir, { recursive: true });

  let manifest;
  if (existing) {
    manifest = await readManifest(id);
    if (manifest.direction !== direction) {
      const err = new Error('该批次已存在且方向不同，请换一个批次名');
      err.status = 409;
      throw err;
    }
    if (sessionName) manifest.name = sessionName; // 允许追加时更新批次名
  } else {
    manifest = {
      id,
      name: sessionName || '未命名批次',
      direction,
      createdAt: new Date().toISOString(),
      files: []
    };
  }

  let seq = manifest.files.length;
  for (const f of tmpFiles.files) {
    seq += 1;
    const origName = f.origName;
    const stored = `${seq}_${sanitizeName(origName) || 'file'}`;
    const dest = path.join(dir, stored);
    try {
      await fsp.rename(f.tmpPath, dest);
    } catch (_) {
      await fsp.copyFile(f.tmpPath, dest);
      await fsp.unlink(f.tmpPath).catch(() => {});
    }
    manifest.files.push({
      seq,
      stored,
      origName,
      size: f.size,
      mime: f.mime || 'application/octet-stream',
      uploadedAt: new Date().toISOString()
    });
  }
  await writeManifest(manifest);
  return manifest;
}

async function findSession(id) {
  if (!id || /[\\/]|\.\./.test(id)) return null; // 防目录穿越
  try {
    return await readManifest(id);
  } catch (_) {
    return null;
  }
}

/* ---------------------------- API 路由 ---------------------------- */

// 批量上传
app.post('/api/upload', upload.array('files', MAX_FILES), async (req, res, next) => {
  try {
    const rawFiles = Array.isArray(req.files) ? req.files : [];
    if (rawFiles.length === 0) {
      return res.status(400).json({ error: '未收到任何文件（表单字段名须为 files）' });
    }
    const direction = req.body.direction === 'pc' ? 'pc' : 'phone';
    const sessionName = sanitizeName(req.body.sessionName || '').slice(0, 60);
    const tmpFiles = {
      sessionId: req.body.sessionId || '',
      files: rawFiles.map(f => ({
        tmpPath: f.path,
        origName: fixFilename(f.originalname),
        size: f.size,
        mime: f.mimetype
      }))
    };
    const manifest = await saveUpload(sessionName, direction, tmpFiles);
    res.json({
      sessionId: manifest.id,
      name: manifest.name,
      direction: manifest.direction,
      count: manifest.files.length,
      files: manifest.files
    });
  } catch (err) {
    next(err);
  }
});

// 会话列表
app.get('/api/sessions', async (_, res, next) => {
  try {
    res.json(await listSessions());
  } catch (err) {
    next(err);
  }
});

// 会话详情
app.get('/api/sessions/:id', async (req, res, next) => {
  try {
    const manifest = await findSession(req.params.id);
    if (!manifest) return res.status(404).json({ error: '会话不存在' });
    res.json({
      id: manifest.id,
      name: manifest.name,
      direction: manifest.direction,
      createdAt: manifest.createdAt,
      files: manifest.files
    });
  } catch (err) {
    next(err);
  }
});

// 单文件流（?inline=1 内联预览）
app.get('/api/file/:id/:seq', async (req, res, next) => {
  try {
    const manifest = await findSession(req.params.id);
    if (!manifest) return res.status(404).json({ error: '会话不存在' });
    const seq = parseInt(req.params.seq, 10);
    const file = manifest.files.find(f => f.seq === seq);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    const filePath = path.join(sessionDir(manifest.id), file.stored);
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch (_) {
      return res.status(404).json({ error: '文件已丢失' });
    }
    const inline = req.query.inline === '1';
    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', contentDisposition(file.origName, inline ? 'inline' : 'attachment'));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    next(err);
  }
});

// 整批打包 ZIP 下载（按命名模板重命名；POST 支持 Excel 序号→名称映射）
//   GET  /api/download/:id?template=...          纯模板命名
//   POST /api/download/:id  body:{template,names} names 为 { "序号": "名称" } 映射，
//        命中映射的文件按 Excel 名称命名（自动补扩展名），未命中的回退模板
async function buildZipDownload(req, res, next, template, nameMap) {
  try {
    const manifest = await findSession(req.params.id);
    if (!manifest) return res.status(404).json({ error: '会话不存在' });
    if (manifest.files.length === 0) return res.status(400).json({ error: '该批次没有文件' });

    const created = new Date(manifest.createdAt);
    const event = sanitizeName(manifest.name) || '未命名批次';
    const dedupe = makeDedupe();
    const map = (nameMap && typeof nameMap === 'object') ? nameMap : {};

    const named = manifest.files.map(f => {
      const dot = f.origName.lastIndexOf('.');
      const ext = (dot >= 0 ? f.origName.slice(dot) : '').toLowerCase();
      const stem = dot >= 0 ? f.origName.slice(0, dot) : f.origName;
      const ctx = {
        seq: pad(f.seq, 3),
        name: stem,
        ext,
        date: fmtDate(created),
        time: fmtTime(created),
        event,
        orig: f.origName
      };
      // Excel 映射优先：序号命中则直接用「名称 + 扩展名」
      let raw;
      const excelName = map[String(f.seq)];
      if (excelName != null && String(excelName).trim() !== '') {
        raw = sanitizeName(String(excelName).trim()) || ctx.seq;
        if (ext && !raw.toLowerCase().endsWith(ext)) raw += ext;
        else if (!ext && !path.extname(raw)) { /* 名称自带扩展名时保留 */ }
      } else {
        raw = renderTemplate(template, ctx);
      }
      const zipName = dedupe(raw);
      return { filePath: path.join(sessionDir(manifest.id), f.stored), zipName, viaExcel: excelName != null };
    });

    const zipName = `${event}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition(zipName));

    const archive = archiver('zip', { zlib: { level: 1 } }); // 图片本身已压缩，低级别更快
    archive.on('warning', err => console.warn('[archiver] warning:', err.message));
    archive.on('error', err => {
      console.error('[archiver] error:', err.message);
      if (!res.headersSent) next(err);
      else res.destroy();
    });
    archive.pipe(res);
    // 关键：预先 stat 并传入 stats 选项。archiver 默认 statConcurrency=4，
    // 不预传 stats 时条目按 stat 完成顺序（而非调用顺序）进入写入队列，导致 ZIP 内顺序随机。
    for (const item of named) {
      let st = null;
      try {
        st = await fsp.stat(item.filePath);
      } catch (_) {
        console.warn('[archiver] 文件已丢失，跳过:', item.zipName);
        continue;
      }
      archive.file(item.filePath, { name: item.zipName, stats: st });
    }
    await archive.finalize();
  } catch (err) {
    next(err);
  }
}

app.get('/api/download/:id', (req, res, next) => {
  buildZipDownload(req, res, next, req.query.template, null);
});

app.post('/api/download/:id', express.json({ limit: '2mb' }), (req, res, next) => {
  const body = req.body || {};
  buildZipDownload(req, res, next, body.template != null ? body.template : req.query.template, body.names);
});

/* ------------------------- 服务信息 / 二维码 ------------------------- */

// 自动检测局域网访问地址（每次请求实时计算，网络切换后刷新页面即更新）
app.get('/api/info', (req, res) => {
  const proto = req.protocol === 'http' || req.secure ? 'http' : 'http';
  const host = req.hostname;
  // 以「请求进来的那个地址」优先展示，其余网卡地址按序附后
  const lans = getLanIPv4s();
  const urls = lans.map(({ name, address }) => ({
    name,
    address,
    phoneUrl: `http://${address}:${PORT}/`,
    pcUrl: `http://${address}:${PORT}/pc`
  }));
  const selfUrl = `http://${host}:${PORT}/`;
  res.json({
    port: PORT,
    selfUrl,
    phoneUrl: selfUrl,
    urls,
    requestedFrom: { address: host, isLocal: host === 'localhost' || host === '127.0.0.1' || lans.some(l => l.address === host) }
  });
});

// 二维码（SVG）：?text= 自定义内容，默认手机端首页地址
app.get('/api/qr', async (req, res, next) => {
  try {
    const host = req.hostname;
    const lans = getLanIPv4s();
    const text = req.query.text || `http://${host === 'localhost' || host === '127.0.0.1' ? (lans[0] ? lans[0].address : host) : host}:${PORT}/`;
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, width: 200 });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-store');
    res.send(svg);
  } catch (err) {
    next(err);
  }
});

/* ---------------------------- 静态页面 ---------------------------- */

app.use(express.static(PUBLIC_DIR));
app.get('/', (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/pc', (_, res) => res.sendFile(path.join(PUBLIC_DIR, 'pc.html')));

/* ---------------------------- 错误处理 ---------------------------- */

// multer 专用错误（超限等）转 400
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: `单个文件超过 ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)}MB 上限` });
  }
  if (err && (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE')) {
    return res.status(400).json({ error: `单次最多上传 ${MAX_FILES} 个文件，字段名须为 files` });
  }
  next(err);
});

// 兜底错误处理
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) console.error('[server error]', err);
  if (!res.headersSent) {
    res.status(status).json({ error: err.message || '服务器内部错误' });
  }
});

/* ---------------------------- 启动 ---------------------------- */

function getLanIPv4s() {
  const result = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const it of ifaces[name] || []) {
      if (it.family === 'IPv4' && !it.internal) result.push({ name, address: it.address });
    }
  }
  return result;
}

async function main() {
  await ensureDirs();
  app.listen(PORT, HOST, async () => {
    const lans = getLanIPv4s();
    console.log('==============================================');
    console.log('  手机↔电脑局域网互传 已启动');
    console.log(`  本机访问:   http://localhost:${PORT}/`);
    lans.forEach(({ name, address }) => {
      console.log(`  局域网[${name}]: http://${address}:${PORT}/   (手机/其他设备)`);
      console.log(`  电脑端页面:      http://${address}:${PORT}/pc`);
    });
    if (lans.length === 0) {
      console.log('  未检测到局域网 IPv4，手机请通过路由器分配的本机 IP 访问');
    }
    console.log('==============================================');
    // 打印第一个局域网地址的二维码，手机扫码直达
    if (lans.length > 0) {
      const url = `http://${lans[0].address}:${PORT}/`;
      try {
        const qr = await QRCode.toString(url, { type: 'terminal', small: true });
        console.log(`手机扫码直达手机传图页 ${url}\n${qr}`);
      } catch (_) { /* 二维码生成失败不影响服务 */ }
    }
  });
}

main().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
