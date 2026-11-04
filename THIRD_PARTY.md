# 第三方依赖与来源

根目录 [LICENSE](LICENSE) 的个人非商业使用及商业授权条款仅适用于本项目原创内容。下列第三方组件、SDK 和其他材料继续遵循各自原有许可证或服务条款；本项目不改变其许可，也不对这些第三方材料另行收取授权费用。

## 协议研究参考：tacshi/Soundcore

**参考仓库：[tacshi/Soundcore](https://github.com/tacshi/Soundcore)，作者：[tacshi](https://github.com/tacshi)。** 它公开了 D3200 设备的协议研究和 Flutter 管理应用，是本项目设备接入的重要参考来源。早期研究记录明确引用了 `PROTOCOL.md` 与 `lib/ble/realtime_stream.dart`；这里同时说明文档与实现参考，保留原作者的贡献归属。

来源核对日期为 **2026-11-04**，对应上游提交 [`f01a19c`](https://github.com/tacshi/Soundcore/tree/f01a19c227aac0cee9a7c851b3f6b69cf5540a24)。下表使用固定版本链接，便于复查；这是本次核对的版本，初期研究记录使用的是上游 `main` 链接。

| 参考内容 | 上游来源 | 本项目对应实现 |
| --- | --- | --- |
| BLE 服务与特征、数据帧和校验、设备信息布局 | [PROTOCOL.md 第 3、4、6 节](https://github.com/tacshi/Soundcore/blob/f01a19c227aac0cee9a7c851b3f6b69cf5540a24/PROTOCOL.md) | [lib/feishu-ble.js](lib/feishu-ble.js)、[lib/ble-frame.js](lib/ble-frame.js)、[lib/d3200-session.js](lib/d3200-session.js) |
| ECDH / HKDF 会话密钥、文件密钥与 AES-CTR 音频解密规则 | [PROTOCOL.md 第 5.6 节](https://github.com/tacshi/Soundcore/blob/f01a19c227aac0cee9a7c851b3f6b69cf5540a24/PROTOCOL.md) | [lib/d3200-crypto.js](lib/d3200-crypto.js) 中的 WebCrypto 实现 |
| 实时音频请求、文件头与分片接收的处理流程 | [PROTOCOL.md 第 5.3 节](https://github.com/tacshi/Soundcore/blob/f01a19c227aac0cee9a7c851b3f6b69cf5540a24/PROTOCOL.md)、[lib/ble/realtime_stream.dart](https://github.com/tacshi/Soundcore/blob/f01a19c227aac0cee9a7c851b3f6b69cf5540a24/lib/ble/realtime_stream.dart) | [lib/d3200-session.js](lib/d3200-session.js)、[lib/ble-frame.js](lib/ble-frame.js) |

### 本项目的实现与补充验证

- 为飞书 H5 环境编写 JavaScript 蓝牙会话与 WebCrypto 模块，配套 Python 网关、StepFun / 豆包适配、本人登录、录音库及私人文档流程。
- 对已取得的飞书 Android 8.3.6 Soundcore SDK 样本补查文件列表、逐个删除与回复匹配、鉴权拒绝响应和音频读取偏移；将核查结果用于实现和边界处理。这些属于在已有协议线索上的补充核对，不把上游已记录的命令或加密机制标为本项目首创。
- 结合 iPhone / D3200 实测处理连接、会话密钥时机和录音保存，并以合成数据编写测试。所测固件 `04.92` 的实时读取仍可能缺少开头数秒，详见[使用与验收](docs/USAGE.md)。

公开发行版采用 JavaScript / Python 实现，未附带上游 Flutter 应用、设备固件、绑定凭据或反编译源文件。原厂 ASR 停用、官方妙记实时字幕接管和固件改造没有作为已完成功能交付，验证范围见 [docs/VALIDATION.md](docs/VALIDATION.md)。

### 上游许可状态

在上述核对版本中，仓库文件树未发现 `LICENSE`、`COPYING` 或 `NOTICE` 文件，GitHub 仓库元数据的 `license` 为 `null`，因此这里不将 `tacshi/Soundcore` 标为 MIT 或其他已明确授予的许可证。来源致谢不代替上游授权；本项目的许可证和商业授权不覆盖上游代码、文档或其他第三方权利。需要复制、分发或商业利用上游材料时，应以原作者明确授予的许可为准。

## 第三方依赖

| 项目 | 用途 | 来源与许可证 |
| --- | --- | --- |
| fflate 0.8.2 | gzip 编解码 | [上游](https://github.com/101arrowz/fflate)；MIT；副本和许可证在 `vendor/`，文件哈希在 `vendor/vendor-lock.json` |
| aiohttp 3.13.5 | HTTP 和 WebSocket | [上游](https://github.com/aio-libs/aiohttp)；Apache-2.0；通过 requirements 安装 |
| libopus | Opus 音频编解码 | [上游](https://opus-codec.org/)；BSD 风格许可证；由使用者通过系统软件源安装，仓库不附带动态库 |
| 飞书 H5 SDK | 端内登录、签名与蓝牙 JSAPI | 页面从飞书官方 CDN 加载；遵循平台使用条款，仓库不复制 SDK |
| Python cryptography（可选） | 重建独立密码学测试向量 | 仅 `test/fixtures/generate-d3200-vectors.py` 需要，运行既有测试不需要安装 |

## 图形与名称

本版空态图形为仓库自行绘制的基本几何 SVG；详情见 [图形来源](ui-assets/PROVENANCE.md)。飞书、Soundcore、StepFun、豆包等名称用于标识兼容对象和服务，相关商标归各自权利人所有。

协议兼容与来源引用不代表获得上述项目作者或厂商背书。
