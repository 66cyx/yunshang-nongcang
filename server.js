const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
// 云端部署时由平台注入 PORT 环境变量；本地默认 3001
const port = process.env.PORT || 3001;

// Vercel 等无服务器平台的文件系统只读，只能用 /tmp 做可写目录
const isServerless = !!process.env.VERCEL;
const BASE_DIR = __dirname;
const DATA_DIR = isServerless ? '/tmp' : __dirname;

// 中间件
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 配置静态资源：前端通过 /upload/xxx 访问图片
app.use('/upload', express.static(path.join(BASE_DIR, 'upload')));

// 数据文件路径：本地在项目目录，无服务器环境放 /tmp
const DB_PATH = path.join(DATA_DIR, 'db.json');
const SEED_DB_PATH = path.join(BASE_DIR, 'db.json');

// ========== 读写数据库函数 ==========
// 读取数据
function readDB() {
  // 无服务器环境的 /tmp 是临时的，首次调用时用打包进来的数据做种子
  if (!fs.existsSync(DB_PATH) && isServerless && fs.existsSync(SEED_DB_PATH)) {
    fs.copyFileSync(SEED_DB_PATH, DB_PATH);
  }
  // 如果文件不存在，创建空数据文件
  if (!fs.existsSync(DB_PATH)) {
    const initData = {
      products: [],
      carts: [],
      orders: [],
      productIdCounter: 100,
      orderIdCounter: 1000
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initData, null, 2));
    return initData;
  }
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  return JSON.parse(raw);
}

// 写入数据
function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ========== base64保存图片工具函数 ==========
function saveBase64Img(base64Str) {
  // 无服务器环境无法把新图片落到可访问的静态目录，直接沿用 base64 存储
  if (isServerless) return base64Str;
  // 拆分base64头部和图片二进制
  const [prefix, imgData] = base64Str.split(',');
  // 生成唯一图片名
  const filename = Date.now() + '_' + Math.floor(Math.random()*9999) + '.png';
  // 本地物理存放路径
  const savePath = path.join(__dirname, 'upload/goods', filename);
  // 写入图片到本地文件夹
  fs.writeFileSync(savePath, Buffer.from(imgData, 'base64'));
  // 返回前端可访问的url路径
  return `/upload/goods/${filename}`;
}
// 万能图片地址处理：老base64 + 新路径图片都能显示
function fixImageUrl(url) {
  // 新图片：路径格式 → 自动补全后端地址
  if (url && url.startsWith('/upload/')) {
    return url;
  }
  // 老图片：base64格式 → 直接用
  return url;
}

// 根路径提示（避免 Cannot GET /）
app.get('/', (req, res) => {
  res.send('<h1>云上农仓后端运行正常</h1><p>商品接口：<a href="/api/products">/api/products</a></p>');
});

// ========== 商品接口 ==========
// 1. 获取所有上架商品
app.get('/api/products', (req, res) => {
  const db = readDB();
  const activeProducts = db.products.filter(p => p.status === 'active');
  res.json(activeProducts);
});

// 2. 按分类获取商品
app.get('/api/products/category/:category', (req, res) => {
  const db = readDB();
  const category = req.params.category;
  const filtered = db.products.filter(p => p.category === category && p.status === 'active');
  res.json(filtered);
});

// 3. 获取单个商品
app.get('/api/products/:id', (req, res) => {
  const db = readDB();
  const id = parseInt(req.params.id);
  const product = db.products.find(p => p.id === id);
  if (!product) return res.status(404).json({ message: '商品不存在' });
  res.json(product);
});

// 4. 上架商品【已修改：base64转文件，imageUrl存路径】
app.post('/api/products', (req, res) => {
  const db = readDB();
  let body = {...req.body};

  // 判断是否是base64图片，是就转成本地文件+存储路径
  if(body.imageUrl && body.imageUrl.startsWith('data:image')){
    body.imageUrl = saveBase64Img(body.imageUrl);
  }

  const newProduct = {
    id: db.productIdCounter++,
    ...body,
    status: 'active'
  };
  db.products.push(newProduct);
  writeDB(db);
  res.status(201).json(newProduct);
});

// 5. 编辑商品【同步修改：编辑上传新图也存路径】
app.put('/api/products/:id', (req, res) => {
  const db = readDB();
  const id = parseInt(req.params.id);
  const idx = db.products.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ message: '商品不存在' });
  
  let body = {...req.body};
  // 编辑时传了新base64图片同样转路径
  if(body.imageUrl && body.imageUrl.startsWith('data:image')){
    body.imageUrl = saveBase64Img(body.imageUrl);
  }

  db.products[idx] = { ...db.products[idx], ...body };
  writeDB(db);
  res.json(db.products[idx]);
});

// 6. 下架商品
app.put('/api/products/:id/status', (req, res) => {
  const db = readDB();
  const id = parseInt(req.params.id);
  const product = db.products.find(p => p.id === id);
  if (!product) return res.status(404).json({ message: '商品不存在' });
  
  product.status = 'inactive';
  writeDB(db);
  res.json({ message: '商品已下架' });
});

// ========== 购物车/订单接口（保留原样） ==========
app.post('/api/cart/add', (req, res) => {
  const db = readDB();
  const { productId, quantity } = req.body;
  const existingIndex = db.carts.findIndex(item => item.productId === productId);
  if (existingIndex > -1) {
    db.carts[existingIndex].quantity += quantity;
  } else {
    db.carts.push({ productId, quantity });
  }
  writeDB(db);
  res.json({ message: '加入购物车成功' });
});

app.post('/api/orders', (req, res) => {
  const db = readDB();
  const newOrder = {
    id: db.orderIdCounter++,
    items: req.body.items,
    total: req.body.total,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  db.orders.push(newOrder);
  writeDB(db);
  res.status(201).json(newOrder);
});

// ========== 前端静态托管（仅本地/常驻服务模式；Vercel 由 CDN 托管 public/） ==========
if (!isServerless) {
  app.use(express.static(path.join(BASE_DIR, 'dist')));
  // SPA 回退：非 /api、/upload 的路径一律返回前端入口，刷新页面不404
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/upload')) return next();
    res.sendFile(path.join(BASE_DIR, 'dist', 'index.html'));
  });
}

// 启动服务（仅直接运行时监听；作为无服务器函数导入时不监听）
if (require.main === module) {
  app.listen(port, () => {
    console.log(`✅ 后端运行在 http://localhost:${port}`);
    console.log(`📦 数据保存在 ${DB_PATH}，重启不丢`);
  });
}

module.exports = app;