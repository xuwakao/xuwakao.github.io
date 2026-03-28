---
title: "Waydroid 源码分析（六）：Audio HAL 与 Vendor 层"
description: "分析 Waydroid 的 Audio HAL 实现和 Vendor 层适配，包括 PulseAudio/PipeWire 对接和硬件抽象层设计"
pubDatetime: 2021-06-17T00:00:00Z
modDatetime: 2021-06-17T00:00:00Z
author: "xuwakao"
slug: "waydroid-audio-vendor"
tags:
  - android
  - linux
  - waydroid
  - audio
  - hal
featured: false
---
# Waydroid 源码分析（六）：Audio HAL 与 Vendor 层

> 本文分析 Waydroid 的 Audio HAL 实现、其他 HAL stub、以及 Vendor 层的配置机制——包括 init.waydroid.rc 服务定义、hosthals.xml HAL 重定向、SEPolicy 配置，以及补丁管理系统。

## 一、Audio HAL

### 架构概述

Waydroid 的 Audio HAL（`android_hardware_waydroid/audio/audio_hw.c`）基于 ALSA/TinyALSA 实现，直接访问宿主机的音频设备。它是 Waydroid "半容器化"设计的典型体现——Audio HAL 进程以 `host` 用户运行，跨越容器边界直接访问宿主机硬件。

### 核心参数

```c
/* 录音参数: 20ms 周期 */
#define CAPTURE_PERIOD_SIZE 320           // 320 帧 = 20ms @ 16kHz
#define CAPTURE_PERIOD_COUNT 2
#define CAPTURE_CODEC_SAMPLING_RATE 16000  // 16kHz

/* 播放参数: ~21ms 周期 */
#define PLAYBACK_PERIOD_SIZE 1024          // 1024 帧 ≈ 21ms @ 48kHz
#define PLAYBACK_PERIOD_COUNT 4            // 4 周期缓冲
#define PLAYBACK_PERIOD_START_THRESHOLD 2  // 2 个周期后开始播放
#define PLAYBACK_CODEC_SAMPLING_RATE 48000 // 48kHz
```

**播放延迟计算**：
- 单个周期: 1024 / 48000 ≈ 21.3ms
- 总缓冲: 4 × 21.3ms ≈ 85ms
- 启动延迟: 2 × 21.3ms ≈ 42ms（`START_THRESHOLD=2`）

这个延迟对于大多数应用场景（视频播放、通知音）是可接受的，但对于实时音频（乐器演奏、游戏音效同步）可能偏高。

### 设备结构

```c
struct alsa_audio_device {
    struct audio_hw_device hw_device;
    pthread_mutex_t lock;
    int out_devices;
    int in_devices;
    struct alsa_stream_in *active_input;
    struct alsa_stream_out *active_output;
    bool mic_mute;
};
```

Audio HAL 同一时间只支持一个活跃的输入流和一个输出流（`active_input`/`active_output`），这是一个简化设计。

### 宿主机连接

Audio HAL 通过 PulseAudio socket 连接到宿主机的音频系统。回顾会话管理中的挂载：

```
宿主机 /run/user/1000/pulse/native → 容器 /run/xdg/pulse/native
```

ALSA 库通过这个 PulseAudio socket（via `alsa-plugins-pulse`）将音频数据传递给宿主机的 PulseAudio/PipeWire 服务。

---

## 二、其他 HAL 实现

### Sensors HAL（空实现）

`android_hardware_waydroid/sensors/` 实现了 `ISensors 1.0` 接口，但所有方法返回空数据：

- `getSensorsList()`: 返回空列表
- `activate()`: 返回 `INVALID_OPERATION`
- `batch()` / `flush()`: no-op

如果宿主机有 `waydroid-sensord` 守护进程，Waydroid 会启动它通过 hwbinder 提供传感器数据。否则设置 `waydroid.stub_sensors_hal=1` 使用 stub。

### Power HAL（空实现）

`android_hardware_waydroid/power/` 的 `IPower 1.0` 实现：

- `setInteractive()`: no-op
- `powerHint()`: no-op
- `getPlatformLowPowerStats()`: 返回空状态

电源管理由宿主机负责，Android 端不需要直接控制。

### Gatekeeper HAL（软件实现）

`android_hardware_waydroid/gatekeeper/` 提供软件级的 `SoftGateKeeper` 实现，用于设备解锁认证。不依赖硬件 TEE（Trusted Execution Environment），因为容器环境中没有 TEE。

### Health HAL

基础的电池和系统健康监控。在容器环境中，电池信息通常不可用。

### 自定义 HIDL 接口

`android_hardware_waydroid/interfaces/` 定义了 Waydroid 专有的 HIDL 接口，用于 Android 端与宿主机的深度交互：

**IWaydroidWindow (v1.0-1.2)**：
- `minimize(packageName)`: 最小化窗口
- `setPointerCapture(packageName, enabled)`: 鼠标锁定（游戏场景）
- `setIdleInhibit(taskID, enabled)`: 防止屏幕息屏

**IWaydroidDisplay (v1.0-1.2)**：
- 显示配置和监控
- `setMouseMetadata()` (v1.2): 设置鼠标光标样式和热点

**IWaydroidClipboard (v1.0)**：
- `sendClipboardData(value)`: Android → 宿主机剪贴板
- `getClipboardData()`: 宿主机 → Android 剪贴板

**IWaydroidTask (v1.0)**：
- Task 状态追踪，HWComposer 用于多窗口管理

---

## 三、Vendor 层配置

### product.mk：构建配置

```makefile
# 安装 hosthals.xml 到系统
PRODUCT_COPY_FILES += \
    $(LOCAL_PATH)/hosthals.xml:$(TARGET_COPY_OUT_SYSTEM)/etc/hosthals.xml

# 安装 init 脚本
PRODUCT_PACKAGES += init.waydroid.rc

# NFC 空配置
PRODUCT_PACKAGES += libnfc-nci.conf

# 禁用 Setup Wizard
PRODUCT_SYSTEM_DEFAULT_PROPERTIES += ro.setupwizard.mode=DISABLED

# PC 模式权限文件
PRODUCT_PACKAGES += pc.xml
```

### hosthals.xml：HAL 重定向声明

`hosthals.xml` 是 HALIUM 环境特有的配置，声明哪些 HAL 应该由宿主机提供而非容器内的 Android：

```xml
<hosthals version="1.0">
    <!-- 图形 HAL → 宿主机 GPU 驱动 -->
    <hal><name>android.hardware.graphics.allocator</name><priority>true</priority></hal>
    <hal><name>android.hardware.graphics.mapper</name><priority>true</priority></hal>

    <!-- 摄像头 → 宿主机 V4L2 -->
    <hal><name>android.hardware.camera.provider</name><priority>true</priority></hal>

    <!-- DRM/媒体 → 宿主机硬件解码 -->
    <hal><name>android.hardware.drm</name><priority>true</priority></hal>
    <hal><name>android.hardware.media.c2</name><priority>true</priority></hal>

    <!-- 位置 → 宿主机 GPS -->
    <hal><name>android.hardware.gnss</name><priority>true</priority></hal>

    <!-- 神经网络 → 宿主机 NPU -->
    <hal><name>android.hardware.neuralnetworks</name><priority>true</priority></hal>

    <!-- 其他硬件 HAL -->
    <hal><name>android.hardware.nfc</name><priority>true</priority></hal>
    <hal><name>android.hardware.ir</name><priority>true</priority></hal>
    <hal><name>android.hardware.power</name><priority>true</priority></hal>
    <hal><name>android.hardware.thermal</name><priority>true</priority></hal>
    <hal><name>android.hardware.vibrator</name><priority>true</priority></hal>
    <!-- ... -->
</hosthals>
```

`priority=true` 表示宿主机的 HAL 实现优先于容器内的。

### init.waydroid.rc：服务配置

这是 Vendor 层最关键的文件。它定义了在 Android init 系统中运行的服务及其权限：

**Audio HAL 服务**：

```
service vendor.audio-hal-2-0 /vendor/bin/hw/android.hardware.audio@2.0-service
    override
    class hal
    user host          ← 关键：以 host 用户运行
    group audioserver audio camera drmrpc inet media mediadrm
          net_bt net_bt_admin net_bw_acct wakelock
    capabilities BLOCK_SUSPEND
    ioprio rt 4        ← 实时 I/O 优先级
    oneshot
```

**HWComposer 服务**：

```
service vendor.hwcomposer-2-1 /vendor/bin/hw/android.hardware.graphics.composer@2.1-service
                              --desktop_file_hint=Waydroid.desktop
    override
    class hal animation
    user host          ← 关键：以 host 用户运行
    group system graphics drmrpc
    capabilities SYS_NICE    ← 允许调整进程优先级
    onrestart restart surfaceflinger  ← HWC 重启时连带重启 SF
    task_profiles ServiceCapacityLow
```

`--desktop_file_hint=Waydroid.desktop` 是传递给 HWComposer 的参数，用于 Wayland 窗口的 app-id 设置。

**Camera Provider 服务**：

```
service vendor.camera-provider-2-4 /vendor/bin/hw/android.hardware.camera.provider@2.4-service
    override
    class hal
    user cameraserver  ← 使用 cameraserver 用户（非 host）
    group audio camera input drmrpc
    capabilities SYS_NICE
    task_profiles CameraServiceCapacity MaxPerformance
```

三个服务运行权限的差异：
- **Audio/HWComposer**: `user host` — 需要直接访问宿主机的 Wayland socket 和 ALSA 设备
- **Camera**: `user cameraserver` — 通过容器内的权限系统访问 `/dev/video*`（设备权限已设为 777）

**属性触发器**：

```
on property:ro.vndk.version=28
    mount none /dev/null /vendor_extra/lib/libmedia_codecserviceregistrant.so ro bind
```

Android 9（VNDK 28）中有一个不兼容的媒体编解码库。通过将 `/dev/null` 绑定挂载到该库路径，巧妙地"删除"了它。

```
on property:persist.waydroid.multi_windows=true
    mount none /system/etc/hidden_xml/pc.xml /system/etc/permissions/pc.xml ro bind
```

多窗口模式通过绑定挂载 `pc.xml` 权限配置启用 Android 的 PC 模式（freeform 窗口）。`pc.xml` 在 `product.mk` 中安装但默认不激活，只有当 `persist.waydroid.multi_windows=true` 时才"覆盖"到标准权限路径。

**启动时的目录创建**：

```
on post-fs-data
    mkdir /data/icons 0775 system system
    mkdir /data/waydroid_tmp 0755 host system
```

- `/data/icons`: 存放应用图标（UserManager 的 .desktop 文件引用这里的图标）
- `/data/waydroid_tmp`: APK 安装的临时目录（`host` 用户可写）

### SEPolicy 配置

Waydroid 使用极简的 SEPolicy 配置：

**`sepolicy/private/file_contexts`**：
```
/odm_extra      u:object_r:rootfs:s0
/vendor_extra   u:object_r:rootfs:s0
/mnt_extra      u:object_r:rootfs:s0
/run            u:object_r:rootfs:s0
/var            u:object_r:rootfs:s0
/tmp            u:object_r:rootfs:s0
```

所有额外的挂载点都标记为 `rootfs` context。配合 `BoardConfigExtra.mk` 中的：

```makefile
SELINUX_IGNORE_NEVERALLOWS := true
```

这实际上关闭了 SELinux 的 neverallow 强制检查。在容器环境中，标准的 Android SEPolicy 规则会阻止许多必要的跨边界操作（如 `host` 用户访问系统资源），因此 Waydroid 选择了宽松策略。

---

## 四、补丁管理系统

### 结构

```
waydroid-patches/
├── apply-patches.sh          # 自动化应用脚本
├── base-patches-28/           # Android 9 补丁
├── base-patches-29/           # Android 10 补丁
├── base-patches-30/           # Android 11 补丁
│   ├── bionic/
│   ├── build/
│   ├── frameworks/
│   ├── hardware/
│   ├── packages/
│   ├── system/
│   └── vendor/
├── base-patches-33/           # Android 13 补丁
├── roms-patches-29/
└── roms-patches-30/
```

### 应用流程

`apply-patches.sh` 自动检测 Android SDK 版本并应用对应的补丁：

1. 从 `build/make/core/version_defaults.mk` 读取 `PLATFORM_SDK_VERSION`
2. 生成版本特定的 manifest 路径: `manifests-{SDK_VERSION}`
3. 创建 `.repo/local_manifests/` 目录
4. 应用 `01-removes.xml`（移除原始项目）
5. 应用自定义 remote 和项目配置
6. 为每个修补的项目运行 `git am` 应用补丁

补丁涵盖了 Waydroid 对 AOSP/LineageOS 的所有必要修改——从 bionic C 库到 framework 层到系统服务。

### Manifest 生成

`manifest_scripts/generate-manifest.sh` 自动生成 repo manifest：

- `00-remotes.xml`: Waydroid 的 Git remote
- `01-removes.xml`: 需要替换的原始项目
- `02-waydroid.xml`: Waydroid 的项目定义

---

## 五、总结

Vendor 层是 Waydroid "定制 Android" 的核心：

1. **`user host` 服务**: HWComposer 和 Audio HAL 以宿主机用户运行，是"半容器化"的关键实现
2. **hosthals.xml**: 声明式 HAL 重定向，优雅地将硬件访问委托给宿主机
3. **绑定挂载技巧**: 用 `/dev/null` 隐藏不兼容库，用权限文件绑定挂载启用多窗口模式
4. **宽松 SEPolicy**: 为容器环境放松安全约束
5. **版本化补丁管理**: 支持多个 Android 版本的增量修改

---

## 系列总结

六篇文章从不同维度分析了 Waydroid 的完整架构：

| 篇章 | 主题 | 核心发现 |
|------|------|---------|
| 第一篇 | 整体架构与前置知识 | LXC 容器 + 共享内核 + 设备直通 |
| 第二篇 | 容器管理与初始化 | Binderfs/modprobe 双路径、OverlayFS 分层、SHA256+OTA 校验 |
| 第三篇 | 图形栈 | DMA-buf 零拷贝、多窗口 Task→Window 映射、策略模式 Buffer 传递 |
| 第四篇 | 会话与桌面集成 | .desktop 自动生成、Binder IPC、剪贴板/通知桥接 |
| 第五篇 | 网络与设备直通 | 标准网桥+NAT、GPU/摄像头直通、设备权限管理 |
| 第六篇 | Audio HAL 与 Vendor 层 | host 用户 HAL、HAL 重定向、SEPolicy 宽松策略 |

Waydroid 的核心设计哲学可以用一句话概括：**以牺牲安全隔离和宿主内核依赖，换取极致的性能和原生桌面集成度。**

---

*本文基于 [Waydroid](https://github.com/waydroid) 项目源码分析，源码版本 v1.6.2。*
