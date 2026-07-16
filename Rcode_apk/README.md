# Rcode Android

Rcode 的安卓远程控制客户端。手机与电脑登录同一 Rcode 账号后，可以选择在线电脑、发送 Agent 任务、查看实时执行进度，并处理电脑端发出的单次审批请求。

## 当前范围

- 统一账号登录、注册与会话恢复。
- 同账号设备发现和在线状态。
- `执行` 与 `仅规划` 两种远程任务模式。
- 实时返回工作流状态、文本结果和错误。
- 网络切换、应用回到前台与连接失活时自动恢复远程通道。
- 本地缓存账号、设备和最近任务；离线时仍可查看上次同步状态。
- 高风险操作继续使用电脑端权限系统，手机只能批准或拒绝单次请求。
- 不提供任意远程 shell，也不绕过电脑端权限规则。

按当前约定，本目录不包含服务端实现或部署操作；移动端使用 `VITE_AUTH_API_URL` 指向未来的账号/远程中继服务。客户端预留协议见 [`docs/remote-api-contract.md`](docs/remote-api-contract.md)。

## 开发

```bash
npm install
npm run dev
```

构建 Web 资源并同步 Android 工程：

```bash
npm run android:sync
```

在 Android Studio 中打开 `android/`，或运行：

```bash
npm run apk:debug
```

Debug APK 输出到：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

在 macOS 上，`apk:debug` 会优先使用 Android Studio 自带的兼容 JDK，避免系统 Java 版本过新导致 Gradle 无法启动。

## 服务地址

默认连接已经部署的 Rcode Remote Server。需要切换环境时复制 `.env.example` 为 `.env.local`，然后设置：

```env
VITE_AUTH_API_URL=https://rcode-remote-server.kdczyz0728-994.workers.dev
```
