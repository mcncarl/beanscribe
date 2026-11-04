# 第三方依赖与来源

根目录 [LICENSE](LICENSE) 的个人非商业使用及商业授权条款仅适用于本项目原创内容。下列第三方组件、SDK 和其他材料继续遵循各自原有许可证或服务条款；本项目不改变其许可，也不对这些第三方材料另行收取授权费用。

| 项目 | 用途 | 来源与许可证 |
| --- | --- | --- |
| fflate 0.8.2 | gzip 编解码 | [上游](https://github.com/101arrowz/fflate)；MIT；副本和许可证在 `vendor/`，文件哈希在 `vendor/vendor-lock.json` |
| aiohttp 3.13.5 | HTTP 和 WebSocket | [上游](https://github.com/aio-libs/aiohttp)；Apache-2.0；通过 requirements 安装 |
| libopus | Opus 音频编解码 | [上游](https://opus-codec.org/)；BSD 风格许可证；由使用者通过系统软件源安装，仓库不附带动态库 |
| 飞书 H5 SDK | 端内登录、签名与蓝牙 JSAPI | 页面从飞书官方 CDN 加载；遵循平台使用条款，仓库不复制 SDK |
| Python cryptography（可选） | 重建独立密码学测试向量 | 仅 `test/fixtures/generate-d3200-vectors.py` 需要，运行既有测试不需要安装 |

D3200 数据布局参考 [tacshi/Soundcore 的协议文档](https://github.com/tacshi/Soundcore/blob/main/PROTOCOL.md)。本仓库没有打包该项目应用、设备固件、绑定凭据或反编译产物。协议兼容不代表获得厂商背书。

本版空态图形为仓库自行绘制的基本几何 SVG；详情见 [图形来源](ui-assets/PROVENANCE.md)。飞书、Soundcore、StepFun、豆包等名称用于标识兼容对象和服务，相关商标归各自权利人所有。
