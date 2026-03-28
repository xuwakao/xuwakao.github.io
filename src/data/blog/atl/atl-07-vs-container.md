---
title: "ATL深度解析（7）vs 容器化 — 在 Linux 上运行 Android 应用的两条路线"
description: "对比 ATL 翻译层方案和 Waydroid 等容器化方案的技术差异，分析两种路线的优劣势和适用场景"
pubDatetime: 2025-12-18T00:00:00Z
modDatetime: 2025-12-18T00:00:00Z
author: "xuwakao"
slug: "atl-vs-container"
tags:
  - android
  - linux
  - atl
  - container
  - comparison
featured: false
---
# ATL vs 容器化：在 Linux 上运行 Android 应用的两条路线

## 引言

在 Linux 桌面上运行 Android 应用，目前有两条截然不同的技术路线：一条是以 Waydroid、Anbox 为代表的**容器化方案**，在 Linux 内核上运行一个完整的 Android 系统；另一条是以 Android Translation Layer（ATL）为代表的 **API 翻译层方案**，直接重新实现 Android Framework API。

这两条路线背后的工程哲学、技术权衡和适用场景完全不同。本文将从架构原理、源码实现、资源开销、兼容性覆盖和桌面集成等多个维度，对两种方案做深入对比。

## 一、架构本质的差异

### 容器化方案：先全有，再桥接

容器化方案的核心思想是：**在 Linux 上运行一个完整的 Android 系统，然后把 Android 的窗口、输入、音频等桥接到宿主桌面**。

以 Waydroid 为例，它的运行时架构如下：

```
┌────────────────────────────────────────────────────────────┐
│                    Linux 宿主系统                            │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              LXC 容器 / Linux 命名空间                  │  │
│  │                                                       │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │            完整 Android 系统                      │  │  │
│  │  │  init → servicemanager → Zygote                  │  │  │
│  │  │  → SystemServer (100+ 服务: AMS, WMS, PMS...)    │  │  │
│  │  │  → SurfaceFlinger → audioserver → mediaserver    │  │  │
│  │  │  → App 进程 (从 Zygote fork)                     │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  需要：                                                      │
│  ├─ Android 系统镜像 (system.img + vendor.img, ~1GB+)       │
│  ├─ Binder 内核模块（或 binderfs）                           │
│  ├─ ashmem / memfd 支持                                     │
│  └─ Wayland 合成器桥接（将 Android 窗口映射为宿主窗口）       │
└────────────────────────────────────────────────────────────┘
```

这里有几十个进程在运行——和真实 Android 手机上几乎一样。App 调用 `getSystemService("audio")`，会通过 Binder IPC 到达 SystemServer 中真正的 AudioService；调用 `startActivity()`，会经过完整的 AMS 调度流程。兼容性极高，因为它就是真正的 Android。

### ATL：先没有，再按需加

ATL 的思路完全相反：**不运行 Android 系统，只运行 App 本身，用 Linux 原生技术重新实现 App 需要的 API**。

ATL 的运行时架构（来自前面系列文章的分析）：

```
┌────────────────────────────────────────────────────────────┐
│                    Linux 宿主系统                            │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              一个普通的 GTK 进程                        │  │
│  │                                                       │  │
│  │  ART VM (art_standalone)                              │  │
│  │  ├─ api-impl.jar (ATL 的 Android API 重实现)          │  │
│  │  ├─ App 的 Java 字节码                                │  │
│  │  └─ App 的 native .so (通过 bionic_translation 加载)  │  │
│  │                                                       │  │
│  │  libtranslation_layer_main.so (JNI 桥接 → GTK4)      │  │
│  │  libandroid.so (NDK API 重实现)                       │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  不需要：                                                    │
│  ├─ Android 系统镜像                                        │
│  ├─ 内核模块                                                │
│  └─ 容器运行时                                              │
└────────────────────────────────────────────────────────────┘
```

一个进程、一个 GTK 窗口。没有 SystemServer，没有 Binder 驱动，没有 SurfaceFlinger。

## 二、内核依赖：从根本上不同

### 容器化方案的内核要求

容器化方案需要宿主 Linux 内核提供 Android 特有的内核功能：

**Binder 驱动**是最关键的依赖。Android 的整个系统服务架构建立在 Binder IPC 上——没有 Binder，SystemServer 无法启动，App 无法与系统服务通信。现代内核（5.0+）通过 binderfs 提供了支持，但仍需要内核编译时启用 `CONFIG_ANDROID_BINDER_IPC`。不是所有发行版默认启用这个选项，有些需要用户安装 DKMS 模块。

**ashmem（Android Shared Memory）** 用于进程间共享内存。现代内核可以用 memfd 替代，但需要 Android 镜像侧的支持。

**特定版本的内核**：某些 Android 镜像对内核版本有最低要求，与宿主发行版的内核可能不兼容。

### ATL 的内核要求

ATL 对内核没有任何额外要求。从 `src/main-executable/main.c` 可以看到，ATL 的启动过程就是创建一个 GtkApplication：

```c
// src/main-executable/main.c:820
app = gtk_application_new("com.example.demo_application",
    G_APPLICATION_NON_UNIQUE | G_APPLICATION_HANDLES_OPEN | ...);
status = g_application_run(G_APPLICATION(app), argc, argv);
```

它使用的系统调用完全是标准 POSIX——epoll（通过 GLib）、mmap、标准的 EGL/OpenGL。甚至可以在 musl-based 系统（如 Alpine Linux）上运行，Alpine 的测试仓库已经打包了 ATL：

```sh
# doc/Build.md 中记载的 Alpine 安装方式
sudo apk add android-translation-layer
```

**这意味着**：ATL 可以运行在任何标准 Linux 发行版上——包括那些不允许加载第三方内核模块的企业环境、嵌入式系统、非主流发行版。容器化方案在这些环境中可能根本无法部署。

## 三、资源开销对比

### 内存

容器化方案需要运行完整的 Android 系统。SystemServer 本身就占用几百 MB 内存（它加载了 100+ 个 Java 服务和大量 native 库）。加上 Zygote、SurfaceFlinger 等进程，还没打开任何 App 时基础内存占用就在 **500MB-1GB** 左右。

ATL 只有一个进程。基础开销是 ART VM 实例（几十 MB）+ GTK4 运行时。实际内存主要取决于 App 本身，框架层的开销很小。

### 磁盘

容器化需要 Android 系统镜像。以 Waydroid 为例，`system.img`（AOSP 系统分区）+ `vendor.img`（厂商 HAL）通常在 **1-2GB**。

ATL 的安装体积由以下部分组成：
- art_standalone（libart.so + bootclasspath JAR + 工具）：约 100-200MB
- bionic_translation：约 1MB
- ATL 本体（api-impl.jar + libtranslation_layer_main.so + libandroid.so）：约 10-20MB
- framework-res.apk：3.9MB

总计约 **150-250MB**，不到容器化方案的 1/5。

### 启动时间

容器化需要完成 Android 的完整启动序列：init → servicemanager → Zygote（预加载几千个类）→ SystemServer（启动几百个服务）→ 准备好接收 App 启动请求。这通常需要 **10-30 秒**。

ATL 的启动流程（`main.c` 的 `open()` 回调）：创建 ART VM → 解析 Manifest → 创建 Application → 启动 Activity。大部分 App 在 **2-5 秒** 内就能看到界面。

## 四、API 兼容性：最核心的权衡

这是两种方案最根本的差异点。

### 容器化：接近 100% 兼容

容器中运行的就是真正的 AOSP，所有 4500+ 个 Framework API 类都存在且行为正确。App 调用任何 API——无论多冷门——都能得到标准的 AOSP 行为。多进程、Binder IPC、ContentProvider 跨进程通信、AIDL 接口全部正常工作。

### ATL：有意义的子集

从前面系列文章的分析中我们知道，ATL 实现了约 784 个 Java 类（AOSP 有 4500+），其中大量是 stub。让我们用几个具体的 API 来对比：

**startService()** ——容器化方案中，这经过完整的 AMS 调度，支持多进程 Service、权限检查、OOM 管理、前台/后台服务策略。ATL 中（`src/api-impl/android/content/Context.java:411-471`），它是同进程内的反射调用：

```java
// ATL 的 startService 实现（简化）
new Handler(Looper.getMainLooper()).post(() -> {
    Class<? extends Service> cls = Class.forName(className).asSubclass(Service.class);
    Service service = cls.getConstructor().newInstance();
    service.attachBaseContext(new ContextImpl(...));
    service.onCreate();
    service.onStartCommand(intent, 0, 0);
});
```

没有新进程，没有 Binder，就是 `new` 一个对象调方法。对大多数 App 够用（Service 只是后台逻辑的容器），但依赖多进程 Service 的 App 会出问题。

**ContentProvider 多进程** ——ATL 显式跳过声明了独立进程的 Provider（`src/api-impl/android/content/ContentProvider.java:20-26`）：

```java
String process_name = provider_parsed.info.processName;
if (process_name != null && process_name.contains(":")) {
    System.out.println("not creating provider " + provider_parsed.className
        + ", it wants to be started in a new process (" + process_name + ")");
    continue;  // 直接跳过
}
```

容器化方案中，这个 Provider 会被 AMS 在独立进程中正常启动。

**Binder transact()** ——ATL 中是空壳（`src/api-impl/android/os/Binder.java:19`）：

```java
@Override
public boolean transact(int code, Parcel data, Parcel reply, int flags) {
    return false;  // 永远返回 false
}
```

任何依赖 AIDL 跨进程接口的功能在 ATL 中都不会工作。容器化方案有真正的 Binder 内核驱动，AIDL 完全正常。

**ServiceManager.getService()** ——ATL 中永远返回 null（`src/api-impl/android/os/ServiceManager.java:4`）：

```java
public static IBinder getService(String name) {
    return null;
}
```

容器化方案中这会返回 SystemServer 中对应服务的 Binder 代理对象。

### 兼容性的实际影响

| App 类型 | ATL | 容器化 |
|---------|-----|--------|
| 简单游戏（Angry Birds, Gravity Defied） | 可运行 | 可运行 |
| 纯 Java 工具（计算器、记事本） | 大概率可运行 | 可运行 |
| OpenGL ES 游戏 | 可运行（EGL 三缓冲） | 可运行 |
| VR 应用（Oculus Quest 版 BeatSaber） | 可运行（OpenXR 适配） | 通常不支持 |
| 开源 App（NewPipe, F-Droid 上的 App） | 多数可运行 | 可运行 |
| 依赖 Google Play Services 的 App | 不支持 | 可支持（通过 MicroG） |
| 微信、抖音等超级 App | 不支持 | 大概率可运行 |
| 银行/金融 App | 不支持（缺少安全特性） | 可能可运行 |
| 多进程架构的 App | 降级运行或不支持 | 完全支持 |

## 五、桌面集成：ATL 的核心优势

这是 ATL 最显著的优势所在。因为 App 运行在一个普通的 GTK 进程中，它天然地与 Linux 桌面环境融为一体。

### 窗口管理

ATL 中每个 App 就是一个 GTK ApplicationWindow（`main.c:441`）：

```c
window = gtk_application_window_new(app);
```

这意味着：
- 窗口可以被宿主窗口管理器自由管理（最小化、最大化、平铺、工作区切换）
- 标题栏使用宿主桌面的样式
- 任务栏/Dock 中显示为普通应用

容器化方案需要专门的桥接层将 Android 的 SurfaceFlinger 窗口映射到宿主的 Wayland surface。这通常能做到多窗口模式，但窗口行为可能与宿主桌面不完全一致（例如窗口装饰样式、resize 行为）。

### 暗色模式跟随

ATL 监听宿主桌面的主题设置并实时反馈给 App（`src/api-impl-jni/content/android_content_Context.c`）：

通过 XDG Portal 的 `org.freedesktop.appearance` 接口监听系统暗色模式设置，映射到 Android 的 `Configuration.uiMode`：
- 暗色主题 → `UI_MODE_NIGHT_YES` (0x20)
- 亮色主题 → `UI_MODE_NIGHT_NO` (0x10)

同时设置 GTK 自身的 `gtk-application-prefer-dark-theme`，使得系统 UI 和 App 内容同步切换。容器化方案中，Android 系统有自己的暗色模式设置，通常不会自动跟随宿主。

### 剪贴板

ATL 直接使用 GDK 的剪贴板 API（`gdk_clipboard_set()`），与宿主桌面共享同一个剪贴板。容器化方案需要在 Android 和宿主之间做剪贴板桥接，可能存在延迟或格式丢失。

### 文件系统访问

ATL 中 App 的文件存储在 `~/.local/share/android_translation_layer/<apk-name>_/` 下（`main.c:380`），用户可以直接用宿主文件管理器浏览。文件选择器使用 GTK 的 `GtkFileDialog`，可以直接访问宿主文件系统。

容器化方案中，App 的文件在容器内部的 Android 文件系统中，通常需要通过 bind mount 或 virtio-fs 映射特定目录。

### Intent 互操作

ATL 通过 DBus 实现了跨应用 Intent 传递（`doc/DBusIntentApi.md`），允许不同 ATL 实例之间以及 ATL App 与宿主桌面应用之间通过标准的 Freedesktop D-Bus 协议通信：

```bash
# 从命令行向 ATL App 发送 Intent
gdbus call --session --dest org.schabi.newpipe \
  --object-path /org/schabi/newpipe \
  --method org.freedesktop.Application.ActivateAction \
  "startActivity" \
  "[<('android.intent.action.VIEW','','https://youtube.com',{}, '')>]" []
```

Intent 被序列化为 GVariant 格式 `(sssa{sv}s)`，通过标准的 `org.freedesktop.Application.ActivateAction` 方法传递。这意味着 Linux 桌面通知系统可以直接触发 ATL App 的 Activity。

容器化方案中，Intent 在 Android 系统内部通过 AMS 处理，要与宿主桌面互操作需要额外的桥接层。

### .desktop 文件安装

ATL 支持通过 `--install` 参数将 APK "安装"为桌面应用（`main.c:541-640`）：

- 从 APK 中提取应用图标（或通过 Cairo 渲染 Drawable）
- 使用 libportal 的 `xdp_portal_dynamic_launcher_prepare_install()` 创建 .desktop 文件
- 注册到系统的应用列表中

安装后的 App 出现在 GNOME 应用网格或 KDE 应用菜单中，就像原生应用一样。容器化方案中也可以实现类似功能，但通常需要容器管理层（如 Waydroid 的命令行工具）来中介。

## 六、安全模型

### 容器化方案的安全性

容器化方案继承了 Android 的安全模型：
- 每个 App 有独立的 UID 和进程
- SELinux 策略限制 App 的系统调用
- 权限系统（Manifest 声明 + 运行时授权）正常工作
- App 在容器内部，与宿主系统有一定隔离（但 LXC 的隔离不如虚拟机强）

### ATL 的安全性

ATL 当前**没有安全隔离**。所有代码在同一个进程中运行，拥有运行 ATL 的用户的全部权限。`android.os.Process.myUid()` 的实现暗示了这个问题（`src/api-impl/android/os/Process.java:416-418`）：

```java
public static final int myUid() {
    // HACK: provide wrong Uid, as some applications like Whatsapp
    // don't accept files with their own Uid for security reasons
    return -1;
}
```

权限检查也是形式上的（`Context.java:486-491`）：

```java
public int checkCallingOrSelfPermission(String permission) {
    return getPackageManager().checkPermission(permission, getPackageName());
}
```

`PackageManager.checkPermission()` 对存储、GCM 等常见权限无条件授予，其他未处理的权限默认返回 `PERMISSION_DENIED`。由于 App 已经拥有运行用户的全部系统权限，这套机制更多是形式上的——真正的限制要等 bubblewrap 沙箱化实现后才能生效。

ATL 的 README 中提到了未来使用 bubblewrap 进行沙箱化的计划：

> explore using bubblewrap to enforce the security policies that google helpfully forces apps to comply with (and our own security policies, like no internet access for apps which really shouldn't need it)

但目前这还是 Roadmap 上的待办事项。

## 七、图形渲染路径

### 容器化方案

```
App → Android GLES/Vulkan → SurfaceFlinger → (Buffer 传递) → 宿主 Wayland 合成器
```

SurfaceFlinger 在容器内完成合成，然后通过 Wayland 协议或共享缓冲区将最终帧传递给宿主合成器。这引入了一次额外的合成步骤和可能的一次缓冲区拷贝。

### ATL 的渲染路径

ATL 有两种渲染模式（在 Blog 3 中有详细分析）：

**默认模式（ATLSurface 三缓冲）**：

```
App 调用 OpenGL ES → 渲染到 ATL 管理的 FBO
→ eglSwapBuffers → GL texture → EGLImage → GdkTexture
→ GtkWidget 展示纹理 → 宿主合成器
```

App 的 `glBindFramebuffer(GL_FRAMEBUFFER, 0)` 被拦截，重定向到 ATL 管理的帧缓冲对象（`src/libandroid/egl.c:498-504`）：

```c
// src/libandroid/egl.c:498-504
void bionic_glBindFramebuffer(GLenum target, GLuint framebuffer)
{
    if (getenv("ATL_DIRECT_EGL") || framebuffer != 0)
        return glBindFramebuffer(target, framebuffer);  // 直接模式或非默认 FBO：直通
    ATLSurface *atl_surface = g_hash_table_lookup(draw_surface_hashtable, eglGetCurrentContext());
    return glBindFramebuffer(target, atl_surface ? atl_surface->back_buffer->gl_framebuffer : 0);
}
```

逻辑非常精炼：当 App 请求绑定 FBO 0（即"默认帧缓冲"）时，通过当前 EGL 上下文查找对应的 ATLSurface，将其重定向到 ATL 管理的 back buffer FBO。如果处于直接 EGL 模式或绑定的是非零 FBO，则原样传递。

**直接 EGL 模式**（设置 `ATL_DIRECT_EGL` 环境变量）：

```
App 调用 OpenGL ES → 渲染到 Wayland subsurface / X11 子窗口 → 宿主合成器
```

直接模式延迟更低，因为省去了纹理拷贝步骤。两种模式对 App 完全透明。

**Vulkan 渲染**被透明转换（`src/libandroid/native_window.c:396-420`）：

```c
// src/libandroid/native_window.c:396-420
VkResult bionic_vkCreateAndroidSurfaceKHR(VkInstance instance,
    const VkAndroidSurfaceCreateInfoKHR *pCreateInfo, ...)
{
    GdkDisplay *display = gtk_widget_get_display(pCreateInfo->window->surface_view_widget);
    if (GDK_IS_WAYLAND_DISPLAY(display)) {
        VkWaylandSurfaceCreateInfoKHR wayland_create_info = {
            .sType = VK_STRUCTURE_TYPE_WAYLAND_SURFACE_CREATE_INFO_KHR,
            .display = pCreateInfo->window->wayland_display,
            .surface = pCreateInfo->window->wayland_surface,
        };
        return vkCreateWaylandSurfaceKHR(instance, &wayland_create_info, ...);
    }
    // ... X11 路径类似，使用 VkXlibSurfaceCreateInfoKHR
}
```

`VkAndroidSurfaceCreateInfoKHR` 被自动转换为 `VkWaylandSurfaceCreateInfoKHR` 或 `VkXlibSurfaceCreateInfoKHR`，App 完全不知道自己在 Linux 上运行。

### 性能对比

| 维度 | ATL | 容器化 |
|------|-----|--------|
| GL 调用路径 | App → Mesa/NVIDIA（直接） | App → Mesa/NVIDIA（通过容器内驱动） |
| 合成次数 | 1 次（宿主合成器） | 2 次（SurfaceFlinger + 宿主合成器） |
| 缓冲区拷贝 | 默认模式 1 次，直接模式 0 次 | 取决于实现（共享缓冲区可避免） |
| Vulkan | 直接转换为宿主 Vulkan | 通过容器内 Vulkan 驱动 |

理论上 ATL 的直接 EGL 模式延迟最低（没有额外合成步骤），但默认的三缓冲模式增加了约一帧的延迟。容器化方案的性能取决于 SurfaceFlinger 到宿主合成器的缓冲区传递效率。

## 八、App 生态覆盖

### ATL 能运行什么

ATL 的 README 和截图展示了以下已知可运行的应用类型：

- **2D 游戏**：Angry Birds、Gravity Defied、Worms 2 Armageddon
- **OpenGL ES 游戏**：GLES3JNI 示例等
- **VR 应用**：Oculus Quest 版 BeatSaber（通过 OpenXR 适配）
- **开源 App**：NewPipe（YouTube 客户端）、OctoDroid 等

ATL 默认报告 `SDK_INT = 9`（Android 2.3 Gingerbread）（`src/api-impl/android/os/Build.java:112`），这让 App 走兼容代码路径，调用更少的现代 API。可以通过 `--sdk-int` 参数覆盖。

### 容器化能运行什么

几乎所有 Android App——包括微信、抖音、银行 App、Google 系应用（通过 MicroG 或 Play Store 兼容层）。主要限制来自：

- ARM-only App 在 x86 上需要 libhoudini 翻译（性能损失）
- 一些 App 检测到 root/容器环境会拒绝运行
- 需要特定硬件（NFC、指纹传感器）的功能不可用

### 一个独特的 ATL 优势：VR 支持

ATL 有一个容器化方案通常不具备的独特能力——运行 Oculus Quest VR 应用。这是因为 ATL 实现了 OpenXR 的 Android 到桌面转换（`src/libandroid/native_window.c:446-605`）：

```c
// src/libandroid/native_window.c:507-544（简化）
XrResult bionic_xrCreateInstance(XrInstanceCreateInfo *createInfo, XrInstance *instance)
{
    // 用无害扩展替换 Android 专用扩展（避免数组压缩）
    const char *harmless_extension = "XR_KHR_opengl_es_enable";
    const char *extra_exts[] = { "XR_MNDX_egl_enable", "XR_EXT_local_floor" };

    // 复制扩展数组，追加额外扩展
    new_names = malloc(sizeof(*new_names) * (count + ARRAY_SIZE(extra_exts)));
    memcpy(new_names, old_names, count * sizeof(*old_names));

    // 替换：XR_KHR_android_create_instance → harmless_extension
    for (int i = 0; i < count; i++)
        if (!strcmp(new_names[i], "XR_KHR_android_create_instance"))
            new_names[i] = harmless_extension;

    // 追加 EGL 和 local_floor 扩展
    for (int i = 0; i < ARRAY_SIZE(extra_exts); i++)
        new_names[count + i] = extra_exts[i];

    return xr_lazy_call("xrCreateInstance", createInfo, instance);
}
```

容器化方案中，VR 应用需要 Android 的 VR 服务和特定的 HAL 支持，这在容器中通常无法提供。

## 九、维护与长期演进

### 容器化方案的维护

- **Android 镜像更新**：需要跟踪 AOSP 的新版本，重新构建系统镜像。通常由 LineageOS 等社区维护
- **内核兼容性**：每次宿主内核大版本更新可能需要验证 Binder 模块兼容性
- **GPU 驱动**：容器内需要与宿主匹配的 GPU 驱动（mesa, NVIDIA），版本不匹配可能导致 GL 问题
- **工作量**：主要是集成和配置工作，核心 Android 系统由 AOSP 社区维护

### ATL 的维护

- **API 覆盖扩展**：每个新 App 可能需要实现缺失的 API。日常工作模式是"运行 App → 看到 ClassNotFoundError → 加 stub 或实现"
- **不需要跟 Android 版本**：ATL 实现的是稳定的 API 子集，Android 的向后兼容承诺保证旧 API 持续有效
- **更小的核心团队**：不需要维护完整的 Android 系统，只需要维护翻译层
- **风险**：如果 Android API 发生破坏性变更（罕见），ATL 需要跟进。更现实的风险是新兴的渲染框架（如 Jetpack Compose 的 Skia 直接渲染）可能绕过 ATL 实现的 View/Canvas 体系

从 ATL 的 git 历史可以看到典型的维护模式：

```
162e93fd api-impl: Misc stubs
090e8f60 api-impl: add misc stubs (mainly webview)
b1d904be Add more android.nfc getDefaultAdapter variants
63813d92 api-impl: misc fixes for OctoDroid
f1a82126 api-impl: misc fixes for com.peoplefun.wordcross
ff4d9a22 api-impl: misc fixes for metronome and tuner app
```

每个 commit 通常是为了让某个特定 App 能够运行而添加的 stub 或实现。

## 十、总结对比

| 维度 | ATL（翻译层） | 容器化（Waydroid/Anbox） |
|------|-------------|----------------------|
| **本质** | Wine 式 API 重实现 | 虚拟机式完整系统运行 |
| **内核** | 标准 Linux 内核 | 需要 Binder 模块 |
| **安装体积** | ~200MB | ~1-2GB |
| **内存基线** | 几十 MB | ~500MB-1GB |
| **启动时间** | 2-5 秒 | 10-30 秒 |
| **API 覆盖** | 子集（784/4500+ 类） | 接近 100% |
| **多进程** | 不支持 | 完全支持 |
| **Binder IPC** | stub | 完全支持 |
| **桌面集成** | 原生（GTK 窗口） | 需要桥接 |
| **暗色模式** | 跟随系统 | 独立设置 |
| **剪贴板** | 共享 | 需要桥接 |
| **文件访问** | 直接 | 需要映射 |
| **安全隔离** | 无 | 有（UID + SELinux） |
| **VR 应用** | 支持（OpenXR） | 通常不支持 |
| **Google Play Services** | 不支持 | 可支持（MicroG） |
| **维护模式** | 按 App 需求逐步实现 API | 跟踪 AOSP 版本 + 内核兼容 |
| **理想场景** | 简单 App、桌面集成、资源受限 | 复杂 App、高兼容性 |

**两者不是非此即彼的关系。** 一个理想的 Linux 桌面可以同时提供两种方案：日常使用的简单 App 通过 ATL 获得轻量、原生的体验；偶尔需要的复杂 App 通过容器化兜底。ATL 追求的不是替代容器化方案，而是为大量只需要基础 Android API 的 App 提供一条更轻量的路径。

这与桌面 Linux 上运行 Windows 程序的情况如出一辙：大部分程序用 Wine 就够了，少数复杂程序才需要完整的 Windows 虚拟机。ATL 就是 Android 应用领域的 Wine。

---

*本文是 ATL 源码分析系列的补充篇。系列主体六篇文章分别覆盖了：[整体架构](atl-01-architecture-overview.md)、[Java Framework 重实现](atl-02-java-framework-reimplementation.md)、[NDK API 重实现](atl-03-ndk-api-reimplementation.md)、[ART 独立化](atl-04-art-standalone.md)、[Bionic 兼容层](atl-05-bionic-translation.md)、[事件循环融合](atl-06-event-loop-fusion.md)。*
