# H5 运行入口

飞书应用主页设置为 `https://自己的域名/minutes/h5/index.html`。入口跳转到同部署前缀的 `preview.html`，让 JSAPI 在飞书顶层网页容器运行。

`minutes-runtime.js` 连接蓝牙模块和私有网关；`feishu-login.js` 完成端内登录；`file-export.js` 处理手机导出。`d3200-bundle.js` 由 `npm run build` 从 `lib/` 生成。

`index.html?diagnostics=1` 只检查 SDK 方法，不证明签名或设备取音成功。历史静态字幕样例在 `ui-assets/demo.html`；当前正式页面没有 `?demo=1` 开关。样例和诊断都不能代替 [真机验收](../docs/USAGE.md)。

完整部署、应用发布和导航操作见 [项目首页](../README.md)。
